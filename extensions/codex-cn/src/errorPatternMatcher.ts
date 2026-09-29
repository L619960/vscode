/**
 * 错误自愈规则引擎：把确定性环境故障的固定解法从大模型推理中剥离。
 *
 * 工作流程：
 * 1. 命令失败后，用 stderr 正则 + 命令行上下文标签匹配规则库
 * 2. 置信度 ≥ 0.9：自动修复（有 pipeline 走多步管线，否则走单脚本 fixScript）并重试
 * 3. 置信度 0.6~0.89：把根因+修复方案作为上下文喂给大模型
 * 4. 置信度 < 0.6：不干预，走原有 LLM 故障处理链路
 *
 * RepairPipeline（管线）：
 * - 多步命令序列，框架独立顺序执行，中间输出不喂给模型
 * - 每步可设 success 条件（文件存在/输出包含/退出码0）和 onSuccess/onFail 分支
 * - 管线结束只返回精简摘要，避免模型被大量失败重试日志干扰
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

/** 把命令编码为 PowerShell -EncodedCommand 所需的 UTF-16LE base64，彻底避免引号转义问题 */
function encodePsCommand(cmd: string): string {
  const buf = Buffer.alloc(cmd.length * 2)
  for (let i = 0; i < cmd.length; i++) {
    buf.writeUInt16LE(cmd.charCodeAt(i), i * 2)
  }
  return buf.toString('base64')
}

/** 用 base64 编码方式执行 PowerShell 命令，返回 stdout */
function runPs(cmd: string, cwd: string): string {
  return execSync(`powershell.exe -NoProfile -EncodedCommand ${encodePsCommand(cmd)}`, {
    timeout: 120000,
    encoding: 'utf-8',
    windowsHide: true,
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  })
}

/** 管线单步 */
export interface PipelineStep {
  /** 命令模板，支持 {{projectPath}} / {{originalCommand}} 变量 */
  command: string
  /** 成功判定（结构化，不用 eval；多条件任一满足即成功） */
  success?: {
    /** 指定文件存在即成功 */
    fileExists?: string
    /** 命令输出包含此字符串即成功 */
    outputContains?: string
    /** 退出码为 0 即成功（默认 true） */
    exitCodeZero?: boolean
  }
  /** 成功后动作：继续下一步 / 管线成功结束（默认 end_success 当为最后一步时） */
  onSuccess?: 'next' | 'end_success'
  /** 失败后动作：重试本步 / 继续下一步 / 管线失败结束（默认 end_fail） */
  onFail?: 'retry' | 'next' | 'end_fail'
}

/** 修复管线 */
export interface RepairPipeline {
  name: string
  steps: PipelineStep[]
}

export interface ErrorPattern {
  id: string
  /** stderr 正则匹配（i 标志） */
  regex: string
  /** 命令行上下文标签：原始命令需包含至少一个标签才参与匹配 */
  cmdTags: string[]
  cause: string
  /** 0~1，≥0.9 自动执行，0.6~0.89 喂上下文，<0.6 不干预 */
  confidence: number
  /** 单脚本修复（向后兼容；若同时有 pipeline 则优先 pipeline） */
  fixScript?: string
  /** 多步修复管线（优先于 fixScript） */
  pipeline?: RepairPipeline
  /** 单会话内最大触发次数，防死循环 */
  maxRetry: number
}

/** 管线执行结果 */
export interface PipelineResult {
  success: boolean
  /** 每步的执行摘要（命令+成功/失败+输出片段） */
  steps: Array<{ command: string; ok: boolean; output: string }>
  /** 最终描述 */
  summary: string
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
   */
  match(stderr: string, cmd: string): ErrorPattern | null {
    if (!stderr || !this.patterns.length) return null
    const lowerCmd = cmd.toLowerCase()

    for (const pattern of this.patterns) {
      const hasTag = pattern.cmdTags.some(tag => lowerCmd.includes(tag.toLowerCase()))
      if (!hasTag) continue

      try {
        const regex = new RegExp(pattern.regex, 'i')
        if (regex.test(stderr)) {
          if ((this.triggerCount[pattern.id] || 0) >= pattern.maxRetry) continue
          return pattern
        }
      } catch {
        continue
      }
    }
    return null
  }

  /**
   * 判断规则是否带管线
   */
  hasPipeline(pattern: ErrorPattern): boolean {
    return !!pattern.pipeline && pattern.pipeline.steps.length > 0
  }

  /**
   * 执行修复管线：顺序执行多步命令，中间输出不喂模型，只返回最终摘要
   */
  runPipeline(pattern: ErrorPattern, projectPath: string, originalCmd: string): PipelineResult {
    const pipe = pattern.pipeline!
    this.triggerCount[pattern.id] = (this.triggerCount[pattern.id] || 0) + 1

    const stepResults: Array<{ command: string; ok: boolean; output: string }> = []
    let success = false

    for (let i = 0; i < pipe.steps.length; i++) {
      const step = pipe.steps[i]
      const cmd = step.command
        .replace(/\{\{projectPath\}\}/g, projectPath)
        .replace(/\{\{originalCommand\}\}/g, originalCmd)

      let output = ''
      let exitOk = false
      try {
        output = runPs(cmd, projectPath)
        exitOk = true
      } catch (e: any) {
        output = String(e?.stdout || '') + String(e?.stderr || e?.message || '')
        exitOk = false
      }

      // 成功判定：只检查显式指定的条件；未指定任何条件时默认用退出码 0
      let stepOk = exitOk
      if (step.success) {
        const checks: boolean[] = []
        let hasCondition = false
        if (step.success.fileExists !== undefined) {
          hasCondition = true
          const fp = step.success.fileExists.replace(/\{\{projectPath\}\}/g, projectPath)
          checks.push(existsSync(fp))
        }
        if (step.success.outputContains !== undefined) {
          hasCondition = true
          checks.push(output.includes(step.success.outputContains))
        }
        if (step.success.exitCodeZero !== undefined) {
          hasCondition = true
          checks.push(exitOk === step.success.exitCodeZero)
        }
        if (hasCondition) {
          stepOk = checks.every(Boolean)
        }
      }

      // 截断输出，摘要里只保留关键片段
      const outSummary = output.length > 300 ? output.slice(0, 300) + '...' : output
      stepResults.push({ command: cmd, ok: stepOk, output: outSummary })

      if (stepOk) {
        const action = step.onSuccess ?? (i === pipe.steps.length - 1 ? 'end_success' : 'next')
        if (action === 'end_success') { success = true; break }
        // 'next' → 继续下一步
      } else {
        const action = step.onFail ?? 'end_fail'
        if (action === 'retry') {
          // 重试本步一次（再跑一遍同一个 step）
          try {
            const retryOut = runPs(cmd, projectPath)
            stepResults[stepResults.length - 1].output = (retryOut.length > 300 ? retryOut.slice(0, 300) + '...' : retryOut)
            stepResults[stepResults.length - 1].ok = true
            const ra = step.onSuccess ?? (i === pipe.steps.length - 1 ? 'end_success' : 'next')
            if (ra === 'end_success') { success = true; break }
          } catch {
            // 重试也失败，按 end_fail 处理
            success = false
            break
          }
        } else if (action === 'next') {
          // 继续下一步
        } else {
          // 'end_fail'
          success = false
          break
        }
      }
    }

    const summary = success
      ? `修复管线【${pipe.name}】执行成功（${stepResults.length} 步）。你可以继续执行原命令验证。`
      : `修复管线【${pipe.name}】执行失败（${stepResults.filter(s => !s.ok).length}/${stepResults.length} 步未通过）。`

    return { success, steps: stepResults, summary }
  }

  /**
   * 执行单脚本修复（向后兼容）
   */
  runFix(pattern: ErrorPattern, projectPath: string, originalCmd: string): string {
    if (!pattern.fixScript) return ''
    const script = pattern.fixScript
      .replace(/\{\{projectPath\}\}/g, projectPath)
      .replace(/\{\{originalCommand\}\}/g, originalCmd)

    this.triggerCount[pattern.id] = (this.triggerCount[pattern.id] || 0) + 1

    try {
      const output = runPs(script, projectPath)
      return output
    } catch (e: any) {
      return `修复脚本执行失败: ${e?.message || String(e)}`
    }
  }

  /**
   * 生成上下文提示（中置信度规则用，喂给大模型参考）
   */
  getContextHint(pattern: ErrorPattern): string {
    const fix = pattern.pipeline
      ? `管线【${pattern.pipeline.name}】：${pattern.pipeline.steps.map(s => s.command).join(' → ')}`
      : pattern.fixScript || ''
    return `[错误自愈规则命中] 检测到可能的问题：${pattern.cause}\n建议尝试：${fix}\n（置信度 ${pattern.confidence}，由你决定是否执行）`
  }

  /**
   * 生成候选规则草稿（大模型成功解决新故障后调用，不自动写入规则库）
   */
  learnCandidate(stderr: string, solution: string, cause: string): ErrorPattern {
    const lines = stderr.split('\n').filter(l => l.trim())
    const coreError = lines.length > 0 ? lines[lines.length - 1].slice(0, 200) : stderr.slice(0, 200)
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
