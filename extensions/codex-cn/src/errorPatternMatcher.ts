/**
 * 错误自愈规则引擎：把确定性环境故障的固定解法从大模型推理中剥离。
 *
 * 工作流程：
 * 1. 命令失败后，用 stderr 正则 + 命令行上下文标签匹配规则库
 * 2. 置信度 ≥ 0.9：自动执行 fixScript 并重试原命令
 * 3. 置信度 0.6~0.89：把根因+修复方案作为上下文喂给大模型
 * 4. 置信度 < 0.6：不干预，走原有 LLM 故障处理链路
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

export interface ErrorPattern {
  id: string
  /** stderr 正则匹配（i 标志） */
  regex: string
  /** 命令行上下文标签：原始命令需包含至少一个标签才参与匹配 */
  cmdTags: string[]
  cause: string
  /** 0~1，≥0.9 自动执行，0.6~0.89 喂上下文，<0.6 不干预 */
  confidence: number
  /** 修复脚本模板，支持 {{projectPath}} / {{originalCommand}} 变量 */
  fixScript: string
  /** 单会话内最大触发次数，防死循环 */
  maxRetry: number
}

interface RuleLibrary {
  version: number
  patterns: ErrorPattern[]
}

/** 规则库路径：扩展根目录下的 error-patterns.json */
const RULE_FILE = join(__dirname, '..', 'error-patterns.json')

/** 单例缓存 */
let instance: ErrorPatternMatcher | null = null

export class ErrorPatternMatcher {
  private patterns: ErrorPattern[] = []
  private triggerCount: Record<string, number> = {}

  private constructor() {
    this.load()
  }

  /** 获取单例（规则库只加载一次） */
  static getInstance(): ErrorPatternMatcher {
    if (!instance) instance = new ErrorPatternMatcher()
    return instance
  }

  /** 加载规则库 */
  private load(): void {
    try {
      if (!existsSync(RULE_FILE)) {
        console.warn(`[ErrorPatternMatcher] 规则库不存在: ${RULE_FILE}`)
        return
      }
      const lib = JSON.parse(readFileSync(RULE_FILE, 'utf-8')) as RuleLibrary
      this.patterns = lib.patterns || []
    } catch (e) {
      console.error('[ErrorPatternMatcher] 规则库加载失败:', e)
      this.patterns = []
    }
  }

  /**
   * 匹配错误日志
   * @param stderr 命令的标准错误输出
   * @param cmd 原始执行命令（用于上下文标签匹配）
   * @returns 命中的规则，未命中返回 null
   */
  match(stderr: string, cmd: string): ErrorPattern | null {
    if (!stderr || !this.patterns.length) return null
    const lowerCmd = cmd.toLowerCase()

    for (const pattern of this.patterns) {
      // 上下文标签校验：命令行需包含至少一个标签
      const hasTag = pattern.cmdTags.some(tag => lowerCmd.includes(tag.toLowerCase()))
      if (!hasTag) continue

      // 正则匹配 stderr
      try {
        const regex = new RegExp(pattern.regex, 'i')
        if (regex.test(stderr)) {
          // 触发次数超限则跳过
          if ((this.triggerCount[pattern.id] || 0) >= pattern.maxRetry) continue
          return pattern
        }
      } catch {
        // 正则语法错误，跳过该规则
        continue
      }
    }
    return null
  }

  /**
   * 执行修复脚本
   * @returns 执行输出（stdout）
   */
  runFix(pattern: ErrorPattern, projectPath: string, originalCmd: string): string {
    const script = pattern.fixScript
      .replace(/\{\{projectPath\}\}/g, projectPath)
      .replace(/\{\{originalCommand\}\}/g, originalCmd)

    this.triggerCount[pattern.id] = (this.triggerCount[pattern.id] || 0) + 1

    try {
      // 用 PowerShell 执行修复脚本（Windows 环境）
      const output = execSync(`powershell.exe -NoProfile -Command "${script.replace(/"/g, '""')}"`, {
        timeout: 60000,
        encoding: 'utf-8',
        windowsHide: true,
      })
      return output
    } catch (e: any) {
      // 修复脚本本身失败，返回错误信息供日志记录
      return `修复脚本执行失败: ${e?.message || String(e)}`
    }
  }

  /**
   * 生成上下文提示（中置信度规则用，喂给大模型参考）
   */
  getContextHint(pattern: ErrorPattern): string {
    return `[错误自愈规则命中] 检测到可能的问题：${pattern.cause}\n建议尝试：${pattern.fixScript}\n（置信度 ${pattern.confidence}，由你决定是否执行）`
  }

  /**
   * 生成候选规则草稿（大模型成功解决新故障后调用，不自动写入规则库）
   * @returns 候选规则对象，需人工审核后追加到 error-patterns.json
   */
  learnCandidate(stderr: string, solution: string, cause: string): ErrorPattern {
    // 取 stderr 最后一行非空内容作为核心报错（通常比首行更接近根因）
    const lines = stderr.split('\n').filter(l => l.trim())
    const coreError = lines.length > 0 ? lines[lines.length - 1].slice(0, 200) : stderr.slice(0, 200)
    // 转义正则特殊字符
    const escaped = coreError.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    return {
      id: `candidate-${Date.now()}`,
      regex: escaped,
      cmdTags: [],
      cause,
      confidence: 0.7,
      fixScript: solution,
      maxRetry: 1,
    }
  }

  /** 获取已加载的规则数量（用于诊断） */
  get patternCount(): number {
    return this.patterns.length
  }
}
