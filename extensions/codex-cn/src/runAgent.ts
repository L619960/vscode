// Agent 主循环：轮次控制、消息组装、中断检查、tool 结果回喂

import * as vscode from 'vscode'
import { chatCompletion } from './llm.js'
import { getLLMConfig } from './config.js'
import { TOOL_SCHEMAS, CORE_TOOL_SCHEMAS, WRITE_TOOLS, READ_TOOLS, summarizeArgs, summarizeResult, wantsBrowser } from './tools.js'
import { executeToolCall, type ApprovalDecision, type ApprovalRequest, type ExecHooks, type ToolDeps } from './executor.js'
import { ErrorPatternMatcher } from './errorPatternMatcher.js'
import { repairJson, extractFirstCodeBlock } from './jsonRepair.js'
import { SubAgentManager } from './subAgent.js'
import { buildSystemPrompt } from './prompt.js'
import { Session, type SessionMessage, type ToolRun } from './session.js'
import type { TaskBoard, TaskCheckpoint } from './taskBoard.js'
import type { SkillsStore } from './skills.js'
import type { McpManager } from './mcp.js'
import type { ChatMessage, ToolCall } from './types.js'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 连续 LLM 错误上限：超过则终止任务，避免死循环 */
const MAX_CONSECUTIVE_ERRORS = 10
/** 连续空回复（无内容无工具调用）上限：空回复不终止，自动催办继续，超限才停止 */
const MAX_EMPTY_RESPONSES = 10
/** 同一任务内退化循环熔断上限：连续触发即终止任务 */
const MAX_LOOP_TRIPS = 10
/** 停滞硬上限：有产物后连续无进展轮次达此值即熔断 */
const STAGNANT_HARD_LIMIT_WITH_PRODUCT = 20
/** 无产物阶段的硬上限：给强模型充分的规划/探索空间 */
const STAGNANT_HARD_LIMIT_NO_PRODUCT = 40

/**
 * 宿主侧强制执行命令（不经过模型决策、不走审批），拿物理现实的真实结果。
 * 用于"分析瘫痪"时宿主替模型完成验证（ctrl-alt-pray 的 ground-truth 思路）。
 */
function hostExec(command: string, cwd: string, timeoutMs = 30000): { ok: boolean; output: string; exitCode: number } {
  try {
    const stdout = execSync(command, { cwd, timeout: timeoutMs, encoding: 'utf-8', windowsHide: true })
    return { ok: true, output: stdout.trimEnd(), exitCode: 0 }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number; message?: string }
    const output = [err.stdout?.trimEnd(), err.stderr?.trimEnd()].filter(Boolean).join('\n')
    return { ok: false, output: output || err.message || '命令执行失败', exitCode: err.status ?? 1 }
  }
}

/**
 * 构造宿主强制验证命令：
 * - 对所有已产出的 .py 文件跑 py_compile
 * - 工作区存在 smoke_test.py 时追加运行
 * 返回 undefined 表示当前无可用的自动验证手段。
 */
function buildHostVerifyCommand(modifiedPaths: Set<string>, rootDir: string): string | undefined {
  const pyFiles = [...modifiedPaths].filter(p => /\.py$/i.test(p))
  const parts: string[] = []
  if (pyFiles.length) {
    const files = pyFiles.map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ')
    parts.push(`py -m py_compile ${files}`)
  }
  if (existsSync(join(rootDir, 'smoke_test.py'))) parts.push('py smoke_test.py')
  return parts.length ? parts.join(' && ') : undefined
}

/**
 * 退化循环检测：流式文本末尾若有某片段（40~200 字）连续重复 ≥4 次，
 * 判定模型陷入重复输出（典型场景：审批挂起后刷"等待审批..."假动作）。
 */
function detectLoop(text: string): boolean {
  const tail = text.slice(-2400)
  if (tail.length < 240) return false
  for (const unit of [40, 80, 120, 200]) {
    const frag = tail.slice(-unit)
    let count = 0
    let pos = tail.length
    while (pos - unit >= 0 && tail.slice(pos - unit, pos) === frag) { count++; pos -= unit }
    if (count >= 4) return true
  }
  return false
}

/** 截断恢复指令：引导模型用更紧凑的写法或分批 edit */
const TRUNCATION_RECOVERY = [
  '上一次工具调用因参数内容过长，在生成中途被截断（JSON 不完整，服务端无法解析）。',
  '注意：重复同样的一次性写法必然再次失败，必须改为更紧凑的写法或分批写入：',
  '1. 精简代码，去掉冗余注释与空行，用更紧凑的风格重写；',
  '2. 或先 write_file 写入核心结构，再用 edit_file 分批补充细节；',
  '现在只输出精简后的 write_file 调用。',
].join('\n')

/** write_file 单次行数上限（仅防 JSON 截断，不阻止执行） */
// const WRITE_FILE_MAX_LINES = 2000 — 不再使用，保留注释说明
/** edit_file 单批 replace 行数上限（仅防 JSON 截断，不阻止执行） */
// const EDIT_BATCH_MAX_LINES = 1500 — 不再使用，保留注释说明

/**
 * 写类工具规模检查：已关闭，不再限制模型发挥。
 */
function enforceWriteSizePolicy(_name: string, _args: Record<string, unknown>): string {
  return ''
}

/** 由扩展实现：审批桥（原生弹窗+Diff）与 webview 状态推送 */
export interface AgentDeps {
  session: Session
  getApiKey(): Promise<string>
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>
  onChange(): void
  toolDeps: ToolDeps
  subAgents?: SubAgentManager
  taskBoard?: TaskBoard
  skills?: SkillsStore
  /** 计划确认模式：开启后写/执行类工具必须先经 submit_plan 获用户批准 */
  planMode?: boolean
  /** Superpowers 方法论：开启后以技能优先 + brainstorm/TDD/评审流程替代默认六步工作流 */
  superpowers?: boolean
  /** MCP 工具管理器：外部工具服务器（动态扩展工具集） */
  mcp?: McpManager
  /** 跨会话用户记忆写入 */
  saveUserMemory?: (content: string) => Promise<void>
  /** 跨会话用户记忆读取（启动时注入） */
  getUserMemory?: () => Promise<string>
}

/** 2 层目录摘要 */
async function buildDirSummary(): Promise<string> {
  const lines: string[] = []
  async function walk(uri: vscode.Uri, depth: number): Promise<void> {
    if (depth > 2 || lines.length > 80) return
    let entries: [string, vscode.FileType][]
    try { entries = await vscode.workspace.fs.readDirectory(uri) } catch { return }
    for (const [name, type] of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue
      lines.push('  '.repeat(depth - 1) + (type === vscode.FileType.Directory ? '📁 ' : '📄 ') + name)
      if (type === vscode.FileType.Directory) walk(vscode.Uri.joinPath(uri, name), depth + 1)
    }
  }
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder) await walk(folder.uri, 1)
  return lines.join('\n').slice(0, 10000)
}

/** 历史压缩阈值（字符数）：超过则把早期消息折叠为摘要，而不是硬截断 */
const COMPRESS_THRESHOLD = 100000
/** 压缩时保留最近的消息条数（约 8 组 user/assistant 交互） */
const KEEP_RECENT_MESSAGES = 16

function msgLen(m: ChatMessage): number {
  return (typeof m.content === 'string' ? m.content.length : 0)
    + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0)
}

/**
 * 历史压缩：总长度未超阈值时原样返回；否则保留 system prompt + 最近 8 条，
 * 更早的消息折叠成一条摘要（含关键工具操作记录），避免上下文无限膨胀
 */
function compressHistory(messages: ChatMessage[]): ChatMessage[] {
  const total = messages.reduce((n, m) => n + msgLen(m), 0)
  if (total <= COMPRESS_THRESHOLD) return messages

  const system = messages[0]?.role === 'system' ? messages[0] : undefined
  const rest = system ? messages.slice(1) : messages.slice()
  if (rest.length <= KEEP_RECENT_MESSAGES) return messages

  const old = rest.slice(0, -KEEP_RECENT_MESSAGES)
  const recent = rest.slice(-KEEP_RECENT_MESSAGES)
  // 丢掉 recent 开头的孤儿 tool 消息（对应 assistant 调用已被折叠），避免协议错乱
  while (recent.length && recent[0].role === 'tool') recent.shift()
  // 丢掉 recent 末尾配对不全的 assistant(tool_calls)（其 tool 消息被切到 old 折叠），
  // 否则 llama/OpenAI 校验报 "insufficient tool messages following tool_calls message"
  while (recent.length && recent[recent.length - 1].role === 'assistant' && recent[recent.length - 1].tool_calls?.length) {
    old.push(recent.pop()!)
  }

  // 从早期消息中提取关键决策（工具调用记录）
  const decisions: string[] = []
  for (const m of old) {
    if (m.role !== 'assistant' || !m.tool_calls) continue
    for (const tc of m.tool_calls) {
      try {
        const args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
        const target = String(args.path || args.command || args.query || '').slice(0, 80)
        decisions.push(target ? `${tc.function.name} ${target}` : tc.function.name)
      } catch { decisions.push(tc.function.name) }
    }
  }
  const summaryMsg: ChatMessage = {
    role: 'user',
    content: `[...earlier conversation summarized...] 早期 ${old.length} 条消息已折叠。`
      + (decisions.length
        ? `\n关键操作记录：\n${decisions.slice(0, 20).map((d) => `- ${d}`).join('\n')}`
        : ''),
  }
  return system ? [system, summaryMsg, ...recent] : [summaryMsg, ...recent]
}

/** 解析用户消息中的 @引用，读取文件或目录内容并拼接到消息前 */
async function resolveAtReferences(text: string, workspaceRoot: string): Promise<string> {
  const regex = /@([^\s]+)/g
  const refs = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    refs.add(m[1])
  }
  if (refs.size === 0) return text

  const blocks: string[] = []
  const rootUri = vscode.Uri.file(workspaceRoot)

  for (const ref of refs) {
    const uri = vscode.Uri.joinPath(rootUri, ref)
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (stat.type === vscode.FileType.Directory) {
        const entries = await vscode.workspace.fs.readDirectory(uri)
        const lines = entries
          .filter(([name]) => !name.startsWith('.') && name !== 'node_modules')
          .map(([name, type]) => (type === vscode.FileType.Directory ? '📁 ' : '📄 ') + name)
        blocks.push(`[File: ${ref}]\n${lines.join('\n')}\n[/File]`)
      } else {
        const buf = await vscode.workspace.fs.readFile(uri)
        const content = new TextDecoder('utf-8').decode(buf)
        const lines = content.split('\n')
        const limited = lines.length > 100
          ? lines.slice(0, 100).join('\n') + `\n... (已截断，共 ${lines.length} 行)`
          : content
        blocks.push(`[File: ${ref}]\n${limited}\n[/File]`)
      }
    } catch {
      // 文件不存在则跳过
    }
  }

  if (blocks.length === 0) return text
  return blocks.join('\n\n') + '\n\n' + text
}

/** 技能索引：只把名称+一句话预览注入系统提示，完整内容用 load_skill 按需加载（省每轮 token） */
/** 支持项目级过滤：仅列出与当前项目关联的技能，无关联时回退到全部技能（避免 Agent 无技能可用） */
/** Superpowers 开启时：追加内置技能分组（个人技能 + Superpowers 技能） */
async function buildSkillIndex(skills?: SkillsStore, workspaceRoot?: string, superpowers?: boolean): Promise<string> {
  if (!skills) return ''
  try {
    let list = await skills.list()
    // 若在工作区内，尝试按项目关联过滤
    if (workspaceRoot) {
      const linked = await skills.getLinkedSkills(workspaceRoot)
      // 有关联配置且存在已关联技能 → 只显示关联的
      if (linked.length > 0) {
        list = list.filter(s => linked.includes(s.name))
      }
      // linked 为空（未配置或全取消）→ 显示全部技能，避免 Agent 无技能可用
    }
    const personal = list.map(s => `- ${s.name.replace(/\.md$/, '')}：${(s.preview || '').split('\n')[0].slice(0, 60)}`)

    if (superpowers) {
      const sections: string[] = []
      if (personal.length) sections.push(`【个人技能】\n${personal.join('\n')}`)
      const vendor = await skills.listVendor()
      if (vendor.length) {
        sections.push('【Superpowers 内置技能】（load_skill 的 name 用下列英文目录名；需附属文件时加 file 参数）\n'
          + vendor.map(v => `- ${v.name}：${v.description}`).join('\n'))
      }
      return sections.join('\n\n')
    }
    return personal.join('\n')
  } catch { return '' }
}

/** 任务类型识别：bug 修复 / 研究分析 / 新功能开发，注入对应侧重点 */
function detectTaskType(text: string): string | undefined {
  const t = text.toLowerCase()
  if (/bug|fix|报错|错误|崩溃|异常|broken|throw|error/.test(t)) return 'bug'
  if (/研究|调研|分析|explain|what|how|why|对比|区别|查看/.test(t) && !/开发|实现|添加|创建/.test(t)) return 'research'
  if (/开发|实现|添加|创建|新建|feature|add|create|build/.test(t)) return 'feature'
  return undefined
}

async function buildApiMessages(
  session: Session, skills?: SkillsStore, planMode?: boolean, userMemory?: string, resolvedText?: string, superpowers?: boolean
): Promise<ChatMessage[]> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  const wsName = folder?.name || '（无）'
  const dirSummary = await buildDirSummary()
  const skillIndex = await buildSkillIndex(skills, folder?.uri.fsPath, superpowers)
  const taskType = resolvedText ? detectTaskType(resolvedText) : undefined
  const systemPrompt = await buildSystemPrompt(wsName, dirSummary, folder?.uri.fsPath, skillIndex, planMode, userMemory, taskType, superpowers)
  const systemMsg: ChatMessage = { role: 'system', content: systemPrompt }

  const all: ChatMessage[] = []
  for (const m of session.messages) {
    if (m.role === 'user') {
      all.push({ role: 'user', content: m.content })
    } else {
      const doneRuns = (m.toolRuns || []).filter((t) => ['done', 'error', 'rejected'].includes(t.status))
      all.push({
        role: 'assistant',
        content: m.content || null,
        ...(doneRuns.length
          ? {
            tool_calls: doneRuns.map((t) => ({
              id: t.id, type: 'function' as const,
              function: { name: t.name, arguments: t.argsJson || '{}' },
            })),
          }
          : {}),
      })
      for (const t of doneRuns) {
        all.push({ role: 'tool', tool_call_id: t.id, content: t.resultJson || '{"ok":false,"error":"无记录"}' })
      }
    }
  }

  return compressHistory([systemMsg, ...all])
}

/** 单个工具结果长度上限（字符）——设为极大值，实际不截断 */
const TOOL_RESULT_MAX = 200000

/**
 * 工具结果不再截断——让模型自由看到完整输出。
 * 仅在极端超长时兜底防 OOM。
 */
function truncateToolResult(_name: string, result: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(result).length <= TOOL_RESULT_MAX) return result
  // 仅在超过 200K 字符时才截断（实际几乎不会触发）
  const out: Record<string, unknown> = { ...result }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.length > TOOL_RESULT_MAX) {
      out[k] = v.slice(0, TOOL_RESULT_MAX) + '\n... (extremely long output truncated)'
    }
  }
  return out
}

/** 单个工具执行超时（毫秒） */
const TOOL_TIMEOUT_MS = 30000
/** install 类命令需要下载大量文件（electron 二进制 100MB+），放宽到 3 分钟 */
const INSTALL_TIMEOUT_MS = 180000
const INSTALL_CMD_RE = /\b(npm|pnpm|yarn)\s+(install|i|ci)\b|\bpip3?\s+install\b|\bpy\s+-m\s+pip\b/i

/** 带超时执行工具：超时返回错误结果而不是挂死主循环。
 *  等待人工审批期间暂停计时（审批可无限期等待，人工决定优先于机器超时）。 */
async function executeToolWithTimeout(call: ToolCall, hooks: ExecHooks, deps: ToolDeps): Promise<Record<string, unknown>> {
  const n = call.function?.name || ''
  let cmdArg = ''
  if (n === 'run_command' || n === 'await_shell') {
    try { cmdArg = String(JSON.parse(String((call.function as { arguments?: string } | undefined)?.arguments || '{}')).command || '') } catch { /* 参数解析失败按普通命令处理 */ }
  }
  const limit = n === 'await_shell' ? 70000
    : n.startsWith('browser_') ? 50000
      : n === 'run_command' && INSTALL_CMD_RE.test(cmdArg) ? INSTALL_TIMEOUT_MS
        : TOOL_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let remaining = limit
  let stageStart = Date.now()
  let raceResolve: (v: Record<string, unknown>) => void = () => { }
  const timeoutP = new Promise<Record<string, unknown>>((resolve) => {
    raceResolve = resolve
    timer = setTimeout(() => raceResolve({ ok: false, error: `工具执行超过 ${limit / 1000} 秒已超时。请缩小操作范围或换一种方式重试` }), limit)
  })
  const armedHooks: ExecHooks = {
    ...hooks,
    requestApproval: async (req) => {
      // 进入人工审批：暂停超时计时
      if (timer) { clearTimeout(timer); timer = undefined; remaining -= Date.now() - stageStart }
      try {
        // 审批超时 60 秒：超时自动拒绝，避免 Agent 无限等待
        const APPROVAL_TIMEOUT = 60000
        const approvalP = hooks.requestApproval(req)
        const timeoutP = new Promise<ApprovalDecision>((_, reject) => {
          setTimeout(() => reject(new Error('审批超时 60 秒，自动拒绝')), APPROVAL_TIMEOUT)
        })
        return await Promise.race([approvalP, timeoutP])
      } catch (e) {
        // 审批超时或错误：返回拒绝
        return { decision: 'deny' as const, reason: (e as Error).message || '审批超时或取消' }
      } finally {
        // 审批结束：恢复剩余计时（至少保留 5 秒给命令本身）
        stageStart = Date.now()
        timer = setTimeout(() => raceResolve({ ok: false, error: `工具执行超过 ${limit / 1000} 秒已超时。请缩小操作范围或换一种方式重试` }), Math.max(remaining, 5000))
      }
    },
  }
  try {
    return await Promise.race([executeToolCall(call, armedHooks, deps), timeoutP])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 文件不存在类错误：附加恢复提示，引导 AI 先列目录确认路径 */
function withFileNotFoundHint(result: Record<string, unknown>): Record<string, unknown> {
  if (result.ok !== false) return result
  if (!/notfound|不存在|no such file|cannot find|找不到/i.test(String(result.error || ''))) return result
  return { ...result, hint: '文件似乎不存在。建议先用 list_dir 列出相关目录确认实际路径后再重试。' }
}

/**
 * Agent 主循环
 * @param userText 用户本轮输入
 * @param deps 扩展注入的依赖
 * @param token 取消令牌
 */
export async function runAgent(userText: string, deps: AgentDeps, token: vscode.CancellationToken): Promise<void> {
  const apiKey = await deps.getApiKey()
  const llmConfig = getLLMConfig(apiKey)
  const folder = vscode.workspace.workspaceFolders?.[0]
  const resolvedText = folder ? await resolveAtReferences(userText, folder.uri.fsPath) : userText
  const userMemory = deps.getUserMemory ? await deps.getUserMemory() : ''
  let messages = await buildApiMessages(deps.session, deps.skills, deps.planMode, userMemory, resolvedText, deps.superpowers)
  messages.push({ role: 'user', content: resolvedText })

  // 用户消息入会话：作为时间线回合的边界，并在 UI 上显示提问原文
  deps.session.add({ role: 'user', content: userText, time: deps.session.now() })
  deps.onChange()

  const abort = new AbortController()
  token.onCancellationRequested(() => abort.abort())

  let lastAssistantMsg: SessionMessage | undefined
  // 流程闸门状态：跨用户回合保持（Session 运行时字段）；重启后从消息历史重建
  const restorePlanState = (): { planned: boolean; skillKeys: string[] } => {
    const skillKeys = new Set<string>()
    let planned = false
    for (const msg of deps.session.messages) {
      for (const tr of msg.toolRuns || []) {
        if (tr.name === 'todo_write') planned = true
        if (tr.name === 'load_skill') {
          if (/brainstorming|writing-plans/.test(tr.resultSummary)) planned = true
          try {
            const r = JSON.parse(tr.resultJson || '{}') as Record<string, unknown>
            const nm = String(r.name || '').trim()
            if (nm) {
              const base = nm.replace(/\.md$/, '')
              // 成功的加载：vendor 有 file 字段；个人技能无 file（两种可能键都加入，任一重复都拦截）
              skillKeys.add(`vendor:${base}:${String(r.file || 'SKILL.md')}`)
              skillKeys.add(`personal:${nm.endsWith('.md') ? nm : `${nm}.md`}`)
            }
          } catch { /* 结果非 JSON，忽略 */ }
        }
      }
    }
    return { planned, skillKeys: [...skillKeys] }
  }
  const restored = restorePlanState()
  let didPlan = deps.session.runtimeDidPlan || restored.planned
  const loadedSkills: Set<string> = deps.session.runtimeLoadedSkills
    ?? (deps.session.runtimeLoadedSkills = new Set(restored.skillKeys))
  /** 统一同步规划状态到会话（跨用户回合保持） */
  const markPlanned = (): void => { didPlan = true; deps.session.runtimeDidPlan = true }
  // 先读后改闸门：记录已读文件与已改文件（相对路径，统一 \ 为小写便于比较）
  const normPath = (p: unknown): string => String(p || '').replace(/\//g, '\\').toLowerCase()
  const readPaths = new Set<string>()
  const modifiedPaths = new Set<string>()
  // ★ 错误记忆沉淀：追踪"未匹配错误 → 模型编辑修复 → 验证成功"链路
  // pendingLearn 记录最近一次未被规则引擎匹配的命令错误；模型编辑后若验证成功则沉淀为学习规则
  let pendingLearn: { stderr: string; cmd: string; fixFiles: Set<string> } | null = null
  const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (projectRoot) ErrorPatternMatcher.getInstance().loadLearned(projectRoot)
  let lastVerifyRound = 0   // 最近一次验证类工具（run_command / read_lints / await_shell）成功所在轮
  let lastModifyRound = 0   // 最近一次写类工具成功所在轮
  let verifyRemindCount = 0 // 验证闸门拦截次数：允许拦截 2 次，第 3 次放行防死循环
  // 计划确认模式：写/执行类工具必须先 submit_plan 并获用户批准
  let planApproved = !deps.planMode
  try {
    let consecutiveErrors = 0
    let consecutiveEmpty = 0
    let loopTripCount = 0 // 退化循环熔断累计（跨轮，达上限终止任务）
    let confirmBlocked = 0 // "请确认"零产出收尾拦截次数（最多 2 次防死循环）
    let stagnantActionRounds = 0 // 连续"只读/规划无推进"轮数
    let stagnantWarned = 0 // 停滞处置次数：第 1 次措辞催办，第 2 次宿主强制求真
    let stagnantTotal = 0 // 累计停滞轮数（措辞/求真后不归零），达 STAGNANT_HARD_LIMIT 熔断
    let deliveryRemindCount = 0 // 交付闸门拦截次数（冒烟通过后仍规划时强制汇报，最多 2 次）
    let stoppedReason: 'stagnant' | null = null
    for (let round = 1; ; round++) {
      if (token.isCancellationRequested || abort.signal.aborted) return

      // 每轮开始前压缩一次历史，防止长任务中上下文无限膨胀
      messages = compressHistory(messages)

      const assistantMsg: SessionMessage = deps.session.add({
        role: 'assistant', content: '', time: deps.session.now(), toolRuns: [],
      })
      lastAssistantMsg = assistantMsg
      deps.onChange()

      // ★任务锚定：第 2 轮起每轮重申原始目标，防止任务漂移到无关工作（如跑去分析其他文件）
      if (round > 1) {
        const goal = resolvedText.replace(/\s+/g, ' ').slice(0, 120)
        messages.push({
          role: 'user',
          content: `[系统锚定] 本轮的唯一任务目标：「${goal}」。下一步动作必须直接服务该目标、使用简体中文，不要重复已完成的工作，不要分析无关文件。`,
        })
      }

      // ★分析瘫痪三级处置：
      //   Level 1 连续停滞 2 轮：措辞强制具体行动
      //   Level 2 措辞后仍停滞 2 轮：宿主直接执行验证，真实结果作为 tool 消息注入（不依赖模型自觉）
      //   Level 3 累计停滞达 STAGNANT_HARD_LIMIT：强制终止并如实汇报（轮末检查）
      if (stagnantActionRounds >= 2 && stagnantWarned < 2) {
        const hasFiles = modifiedPaths.size > 0
        const notVerified = lastVerifyRound < lastModifyRound
        if (stagnantWarned === 0) {
          // ── Level 1：措辞催办，按场景直接给具体指令，不给选择 ──
          stagnantWarned++
          let order: string
          if (hasFiles && notVerified) {
            // 有产物但没验证：直接强制跑冒烟，不给选择
            order = `现有产物（${[...modifiedPaths].slice(0, 6).join('、')}）尚未验证。本轮必须立即 run_command 执行冒烟测试：对每个 .py 文件运行 \`py -m py_compile <file>\`，并写一个 smoke_test.py 做实例化+自毁验证（GUI 用 root.after(2000, root.destroy) 自毁，禁止 mainloop 挂起）。验证通过后直接输出三段式交付汇报。禁止再读文件、禁止再规划。`
          } else if (hasFiles) {
            // 有产物且已验证：直接交付
            order = `现有产物（${[...modifiedPaths].slice(0, 6).join('、')}）已验证通过。本轮必须直接输出三段式交付汇报（修改内容/验证方式/当前状态）。禁止再读文件、禁止再规划、禁止再调用任何工具。`
          } else {
            // 还没产物：强制写第一个文件
            order = `尚无任何产物文件。本轮必须立即 write_file 写出第一个可运行的代码文件（数据库模块或主程序入口），写完即 run_command 验证语法。禁止再读文件、禁止再加载技能、禁止只输出分析文本。`
          }
          messages.push({
            role: 'user',
            content: `[系统·行动催办] 你已连续 ${stagnantActionRounds} 轮只在读取文件/加载技能/更新规划，没有任何修改或验证，属于原地打转。${order}`,
          })
          stagnantActionRounds = 0 // 给一轮响应窗口
        } else {
          // ── Level 2：措辞催办无效，宿主强制求真：直接跑验证并把真实结果喂给模型 ──
          stagnantWarned++
          const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
          const command = buildHostVerifyCommand(modifiedPaths, rootDir)
          if (command) {
            const exec = hostExec(command, rootDir)
            const callId = `host_verify_${Date.now()}`
            const resultJson = JSON.stringify({
              ok: exec.ok,
              exit_code: exec.exitCode,
              stdout: exec.output.slice(0, 2000) || '(无输出)',
              note: '本命令由系统检测到分析瘫痪后自动执行（非模型决策），结果为真实运行结果。',
            })
            assistantMsg.toolRuns!.push({
              id: callId,
              name: 'run_command',
              argsSummary: `系统自动验证: ${command.slice(0, 80)}`,
              argsJson: JSON.stringify({ command }),
              status: exec.ok ? 'done' : 'error',
              resultJson,
              resultSummary: exec.ok ? '自动验证通过' : '自动验证失败',
            })
            messages.push({
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: callId,
                type: 'function',
                function: { name: 'run_command', arguments: JSON.stringify({ command }) },
              }],
            })
            messages.push({ role: 'tool', tool_call_id: callId, content: resultJson })
            lastVerifyRound = round
            const verdict = exec.ok
              ? '系统自动验证已通过，真实结果如上。禁止再读文件、禁止再规划，本轮直接输出三段式交付汇报（修改内容/验证方式/当前状态）。'
              : '系统自动验证失败，真实错误如上。禁止再读任何文件，本轮必须只针对上述错误直接修改对应文件，然后用 run_command 重验。'
            messages.push({ role: 'user', content: `[系统·强制求真] ${verdict}` })
          } else {
            // 尚无产物，宿主无法代替创作：最后强制一次写文件，仍不动则由硬上限终止
            messages.push({
              role: 'user',
              content: '[系统·最后通牒] 系统已确认你连续多轮零产出。本轮必须立即 write_file 写出第一个代码文件并验证语法。继续只输出分析文本将强制终止任务。',
            })
          }
          stagnantActionRounds = 0
        }
      }

      // 退化循环熔断：流式生成中检测到重复片段即中止本次请求
      let loopTripped = false
      let streamBuf = ''
      const result = await chatCompletion({
        messages,
        // 浏览器 schema 体量大：仅在任务涉及网页时附带，日常任务每轮省数千 token 的 prefill
        // MCP 工具：由外部服务器动态提供，追加在内置工具之后
        tools: [...(wantsBrowser(resolvedText) ? TOOL_SCHEMAS : CORE_TOOL_SCHEMAS), ...(deps.mcp?.toolSchemas() ?? [])],
        config: llmConfig,
        signal: abort.signal,
        onToken: (t) => {
          assistantMsg.content += t
          streamBuf += t
          if (!loopTripped && streamBuf.length > 240 && detectLoop(streamBuf)) {
            loopTripped = true
            abort.abort()
          }
          deps.onChange()
        },
        onDegraded: () => {
          assistantMsg.content += '> ⚠ 当前模型不支持工具调用，已自动切换纯对话模式\n'
        },
      })

      // 熔断中止：不当作用户取消，走专用纠错路径
      if (loopTripped) {
        messages.pop() // 撤下本轮注入的锚定（第 2 轮起），避免与纠错消息叠加
        loopTripCount++
        if (loopTripCount >= MAX_LOOP_TRIPS) {
          assistantMsg.content = assistantMsg.content.slice(0, 160)
            + '\n\n🚨 连续检测到重复输出（退化循环），已自动停止任务。可重新描述任务、把任务拆小，或开启自动审批后再试。'
          deps.session.save()
          deps.onChange()
          return
        }
        assistantMsg.content = assistantMsg.content.slice(0, 160)
          + '\n\n> 🚨 检测到重复输出（退化循环），本轮已被系统熔断中断。请立即用一次真实的工具调用继续推进任务（如审批被卡就明确告知用户，或换替代方案），禁止再输出重复文本。'
        messages.push({
          role: 'user',
          content: '[系统] 上一轮生成陷入重复循环已被熔断。请立即调用一个直接服务于任务目标的工具继续推进，禁止输出重复或无意义的文本。',
        })
        deps.session.save()
        deps.onChange()
        continue
      }
      if (token.isCancellationRequested || abort.signal.aborted) {
        deps.session.save()
        return
      }
      if (result.error) {
        // LLM 错误：把错误信息作为 system 消息回喂给 AI，让它下一轮自行修正
        consecutiveErrors++
        assistantMsg.content += `\n\n⚠️ ${result.error}`
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          assistantMsg.content += '\n\n连续出错次数过多，已自动停止。'
          deps.session.save()
          deps.onChange()
          return
        }
        assistantMsg.content += `\n\n（第 ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS} 次重试）`
        // 截断类错误：回喂强制分批写入指令；其他错误：泛化回喂让 AI 自行修正
        const feedback = result.truncated
          ? `[系统]\n${TRUNCATION_RECOVERY}`
          : `[系统] 上一次请求出错：${result.error}。请重试或调整方式。`
        messages.push({ role: 'user', content: feedback })
        deps.session.save()
        deps.onChange()
        continue
      }
      consecutiveErrors = 0

      // ★检查点催办：每 5 轮一次，提醒更新 running 过久的检查点。
      // 必须在 push assistant 之前注入——插入 assistant/tool 配对之间会触发 400（tool 必须紧跟 assistant）
      if (round % 5 === 0 && deps.taskBoard) {
        const pending = deps.taskBoard.items.filter((i: TaskCheckpoint) => i.status === 'running')
        if (pending.length > 0) {
          const names = pending.map((i: TaskCheckpoint) => i.label).slice(0, 3).join('、')
          messages.push({
            role: 'user',
            content: `[系统提醒] 任务规划中有 ${pending.length} 个检查点仍处于运行状态（如：${names}）。请及时调用 todo_write 更新已完成的检查点状态，或继续推进任务。`,
          })
        }
      }

      messages.push({
        role: 'assistant',
        content: result.content || null,
        ...(result.toolCalls.length
          ? { tool_calls: result.toolCalls }
          : {}),
      })

      if (result.toolCalls.length === 0) {
        const isEmpty = !(result.content || '').trim()
        // 空回复不立即终止（量化模型偶发空响应，直接结束会让任务半途而废）：
        // 撤下空气泡、回喂催办指令，连续超限才停止
        if (isEmpty && consecutiveEmpty < MAX_EMPTY_RESPONSES) {
          consecutiveEmpty++
          messages.pop()
          deps.session.remove(assistantMsg)
          messages.push({
            role: 'user',
            content: `[系统] 上一次返回了空回复（${consecutiveEmpty}/${MAX_EMPTY_RESPONSES}）。任务尚未完成，请立即继续调用工具完成剩余工作，完成后再总结，禁止空回复。`,
          })
          deps.session.save()
          deps.onChange()
          continue
        }
        // ★确认拦截器：检测"求确认/求指示"类收尾措辞
        const seeksConfirmation = /请.{0,8}确认|确认后(我将|我会|立即|开始)|是否(可以|需要|符合).{0,12}(开始|执行|编码|要求)|请告知|请回复|请选择|请您定夺|您觉得.{0,24}(是否|可否)/.test(result.content)
        // 场景 A：早期轮次零产出却求确认——用户已要求直接实施，强制立刻开工
        if (confirmBlocked < 2 && modifiedPaths.size === 0 && round <= 4 && seeksConfirmation) {
          confirmBlocked++
          messages.pop() // 撤下这条无工具的 assistant 消息
          deps.session.remove(assistantMsg)
          messages.push({
            role: 'user',
            content: `[系统] 用户的需求已完整且明确要求"直接连续做完：设计→实现→冒烟验证→交付"，你的设计无需用户确认（见最高优先级铁律第3条）。现在立刻执行：1) 调用 todo_write 建立任务清单 2) 创建目录并写出第一个真实代码文件。禁止再输出任何"请确认/确认后开始"类文本，必须直接用工具行动。`,
          })
          deps.session.save()
          deps.onChange()
          continue
        }
        // 场景 B：冒烟已通过仍就"执行方式"求指示——功能已闭环，强制直接交付汇报
        if (confirmBlocked < 2 && modifiedPaths.size > 0 && lastVerifyRound >= lastModifyRound && seeksConfirmation) {
          confirmBlocked++
          messages.pop()
          deps.session.remove(assistantMsg)
          messages.push({
            role: 'user',
            content: `[系统] 冒烟验证已经通过、功能已闭环，你不需要再就执行方式征求任何意见（最高优先级铁律第3条）。立即输出最终交付汇报：1) 修改内容（文件与功能点）2) 验证方式（冒烟命令与结果）3) 当前状态（完成度与已知限制）。如实陈述，禁止再提问、禁止再讨论方案选择。`,
          })
          deps.session.save()
          deps.onChange()
          continue
        }
        // ★验证闸门：改过文件但改后未跑过任何验证（run_command / read_lints / await_shell），
        // 拦截本次收尾回喂验证指令（允许 2 次：防止提醒一次后模型继续折腾再收尾时被放行）
        if (modifiedPaths.size > 0 && lastVerifyRound < lastModifyRound && verifyRemindCount < 2) {
          verifyRemindCount++
          messages.pop() // 撤下这条无工具的 assistant 消息
          deps.session.remove(assistantMsg)
          const files = [...modifiedPaths].slice(0, 5).join('、')
          const content = verifyRemindCount === 1
            ? `[系统] 验证闸门：你修改了 ${modifiedPaths.size} 个文件（${files}${modifiedPaths.size > 5 ? ' 等' : ''}），但修改后未运行任何验证。请先用 run_command 运行构建/测试/冒烟脚本（GUI 程序用冒烟脚本实例化后销毁，禁止直接跑主入口），或用 read_lints 检查诊断；确认无报错后再收尾汇报。`
            : `[系统] 验证闸门（第 2 次拦截）：你仍未在最后一次修改后跑通任何验证。请立即按错误信息修复并重跑验证；如果验证确实因环境限制无法通过，必须把完整错误信息、失败原因和当前真实完成度如实汇报后才能收尾，禁止假装验证通过、禁止退回重规划。`
          messages.push({ role: 'user', content })
          deps.session.save()
          deps.onChange()
          continue
        }
        // ★交付闸门：冒烟已通过（验证在最后一次修改之后），模型却输出纯规划文本（无工具调用）而非交付汇报——
        // 检测"计划/规划/Phase/实施"类措辞，强制直接输出三段式交付汇报（允许拦截 2 次）
        const deliveryReady = modifiedPaths.size > 0 && lastVerifyRound >= lastModifyRound
        const looksLikePlanning = /(实施计划|开发计划|详细计划|制定计划|Phase\s*\d|规划阶段|下一步计划|我将制定|创建.*计划文件)/.test(result.content)
        if (deliveryReady && looksLikePlanning && deliveryRemindCount < 2) {
          deliveryRemindCount++
          messages.pop()
          deps.session.remove(assistantMsg)
          const files = [...modifiedPaths].slice(0, 6).join('、')
          messages.push({
            role: 'user',
            content: `[系统·交付闸门] 冒烟验证已通过（第 ${lastVerifyRound} 轮）、产物文件（${files}）已就绪，功能已闭环，无需再制定任何实施计划。本轮必须直接输出最终交付汇报，严格三段式：1) 修改内容（列出文件与功能点）2) 验证方式（冒烟命令与结果，如实）3) 当前状态（完成度、已知限制、运行方式）。禁止再输出计划/规划/Phase 类文本，禁止再加载技能，禁止再调用工具。`,
          })
          deps.session.save()
          deps.onChange()
          continue
        }
        deps.session.save()
        deps.onChange()
        return
      }
      consecutiveEmpty = 0
      let roundHadProgress = false // 本轮是否有修改成功或命令执行（供分析瘫痪检测）

      for (let ci = 0; ci < result.toolCalls.length; ci++) {
        const call = result.toolCalls[ci]
        if (token.isCancellationRequested || abort.signal.aborted) { deps.session.save(); return }

        // ★工具级异常隔离：单个工具调用的意外异常不能杀死整个 Agent 回合（run 留痕为 error，让模型下轮自我修复）
        let run: ToolRun | undefined
        try {
          // ★只读并行批：连续多个只读工具（read_file/search_files/glob/web_* 等）无依赖，并行执行省多轮等待
          if (READ_TOOLS.has(call.function.name)) {
            const batch: ToolCall[] = [call]
            while (ci + 1 < result.toolCalls.length && READ_TOOLS.has(result.toolCalls[ci + 1].function.name)) {
              batch.push(result.toolCalls[++ci])
            }
            if (batch.length > 1) {
              const runs = batch.map(c => {
                const r: ToolRun = {
                  id: c.id, name: c.function.name, argsSummary: '', argsJson: c.function.arguments,
                  status: 'running', resultJson: '', resultSummary: '',
                }
                try { r.argsSummary = summarizeArgs(c.function.name, JSON.parse(c.function.arguments || '{}')) }
                catch { r.argsSummary = '⚠ 参数格式错误' }
                assistantMsg.toolRuns!.push(r)
                return r
              })
              deps.onChange()
              await Promise.all(batch.map(async (c, k) => {
                const r = runs[k]
                const hooks: ExecHooks = {
                  setStatus: (s) => { r.status = s as ToolRun['status']; deps.onChange() },
                  requestApproval: (req) => deps.requestApproval(req),
                }
                try {
                  const raw = await executeToolWithTimeout(c, hooks, deps.toolDeps)
                  const tr = truncateToolResult(r.name, withFileNotFoundHint(raw))
                  r.status = tr.ok ? 'done' : 'error'
                  r.resultJson = JSON.stringify(tr)
                  r.resultSummary = summarizeResult(r.name, tr)
                  // read_lints 属验证类：并行批里也要更新验证轮次，供验证闸门判断
                  if (tr.ok && r.name === 'read_lints') lastVerifyRound = round
                } catch (e) {
                  r.status = 'error'
                  r.resultJson = JSON.stringify({ ok: false, error: (e as Error).message })
                  r.resultSummary = '执行异常'
                }
              }))
              for (const r of runs) {
                messages.push({ role: 'tool', tool_call_id: r.id, content: r.resultJson })
              }
              deps.session.save()
              deps.onChange()
              continue
            }
          }

          let args: Record<string, unknown> = {}
          let argsParseError = ''
          const rawArgs = call.function.arguments || '{}'
          try {
            args = JSON.parse(rawArgs)
          } catch (e) {
            // 弱模型常把大段代码（未转义引号/换行）塞进 JSON 字符串，导致解析失败。
            // 尝试容错修复：状态机转义字符串内的非法字符。
            const repaired = repairJson(rawArgs)
            if (repaired) {
              try {
                args = JSON.parse(repaired)
                // 同步回 call，让执行器 parseArgs 直接拿到修复后的参数
                call.function.arguments = repaired
              } catch {
                argsParseError = `工具参数 JSON 解析失败（修复后仍失败）: ${(e as Error).message}。原始参数前200字符: ${rawArgs.slice(0, 200)}`
              }
            } else {
              argsParseError = `工具参数 JSON 解析失败: ${(e as Error).message}。原始参数前200字符: ${rawArgs.slice(0, 200)}`
            }
          }
          // ★ write_file/edit_file content 回退：参数解析成功但 content 缺失/为空时，
          // 从 assistant 消息文本的 ``` 代码块提取内容（弱模型常把代码放在消息正文而非参数里）
          const tname0 = call.function.name
          if (!argsParseError && (tname0 === 'write_file' || tname0 === 'edit_file')) {
            const hasContent = typeof args.content === 'string' && args.content.trim().length > 0
            if (!hasContent && result.content) {
              const block = extractFirstCodeBlock(result.content)
              if (block && block.content.trim().length > 0) {
                args = { ...args, content: block.content }
                // 同步回 call，让执行器 parseArgs 拿到正确参数
                call.function.arguments = JSON.stringify(args)
              }
            }
          }
          run = {
            id: call.id,
            name: call.function.name,
            argsSummary: argsParseError ? '⚠ 参数格式错误' : summarizeArgs(call.function.name, args),
            argsJson: call.function.arguments,
            status: 'running',
            resultJson: '',
            resultSummary: '',
          }
          assistantMsg.toolRuns!.push(run)
          deps.onChange()

          if (argsParseError) {
            // JSON 解析失败：不执行工具。截断特征（length 结束 / 参数异常长）时回喂分批指令
            const looksTruncated = result.finishReason === 'length'
              || (call.function.arguments || '').length > 3000
            const payload = looksTruncated
              ? { ok: false, error: `工具参数不完整（${result.finishReason === 'length' ? '触及生成长度上限' : 'JSON 被截断'}）`, recovery: TRUNCATION_RECOVERY }
              : { ok: false, error: argsParseError }
            run.status = 'error'
            run.resultJson = JSON.stringify(payload)
            run.resultSummary = looksTruncated ? '参数被截断，需分批写入' : '参数 JSON 解析失败'
            deps.session.save()
            deps.onChange()
            messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
            continue
          }

          const hooks: ExecHooks = {
            setStatus: (s) => { run!.status = s as ToolRun['status']; deps.onChange() },
            requestApproval: (req) => deps.requestApproval(req),
          }

          // 超规模硬拦截：不执行工具，回喂分批写入指令
          const sizeError = enforceWriteSizePolicy(call.function.name, args)
          if (sizeError) {
            run.status = 'error'
            run.resultJson = JSON.stringify({ ok: false, error: sizeError, recovery: TRUNCATION_RECOVERY })
            run.resultSummary = '超规模拦截，需分批写入'
            deps.session.save()
            deps.onChange()
            messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
            continue
          }

          // ★流程闸门：写/执行类工具前必须先 todo_write 拆解（本产品六步工作流硬强制）
          const tname = call.function.name
          if (tname === 'todo_write') markPlanned()
          const isBgManage = tname === 'await_shell' && args.action !== 'start'
          if (!didPlan && WRITE_TOOLS.has(tname) && !isBgManage) {
            const gateMsg = '流程闸门：调用 write_file / edit_file / run_command / await_shell(start) 之前，必须先调用 todo_write 输出 P0/P1 检查点清单'
            run.status = 'error'
            run.resultJson = JSON.stringify({ ok: false, error: gateMsg, recovery: '立即只调用 todo_write（参数 items 为完整检查点数组），再继续执行' })
            run.resultSummary = '流程闸门：需先规划'
            deps.session.save()
            deps.onChange()
            messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
            continue
          }

          // ★计划闸门：计划确认模式下，写/执行类工具必须先 submit_plan 并获用户批准
          if (!planApproved && (WRITE_TOOLS.has(tname) || tname === 'run_command' || tname === 'await_shell') && !isBgManage && tname !== 'submit_plan') {
            const gateMsg = '计划闸门：当前处于计划确认模式，执行写文件/命令前必须先调用 submit_plan 提交实施方案并获用户批准'
            run.status = 'error'
            run.resultJson = JSON.stringify({ ok: false, error: gateMsg, recovery: '立即调用 submit_plan（参数 plan 为分步实施方案），等用户批准后再执行' })
            run.resultSummary = '计划闸门：需先提交方案'
            deps.session.save()
            deps.onChange()
            messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
            continue
          }

          // ★MCP 工具：mcp__server__tool 路由到 McpManager（外部服务器，执行前需用户批准）
          if (tname.startsWith('mcp__')) {
            if (!deps.mcp?.has(tname)) {
              run.status = 'error'
              run.resultJson = JSON.stringify({ ok: false, error: `MCP 工具未连接: ${tname}`, recovery: '检查 codex-cn.mcpServers 配置与服务器进程状态' })
              run.resultSummary = 'MCP 工具未连接'
            } else {
              hooks.setStatus('awaiting')
              const apr = await deps.requestApproval({ toolName: tname, argsSummary: run.argsSummary })
              if (apr.decision !== 'allow') {
                run.status = 'rejected'
                run.resultJson = JSON.stringify({ ok: false, error: `用户拒绝了 MCP 工具调用${apr.reason ? '：' + apr.reason : ''}` })
                run.resultSummary = '用户拒绝'
              } else {
                try {
                  const out = await deps.mcp.call(tname, args)
                  const text = typeof out === 'string' ? out : JSON.stringify(out)
                  run.status = 'done'
                  run.resultJson = JSON.stringify({ ok: true, result: text.slice(0, 8000) })
                  run.resultSummary = text.slice(0, 60).replace(/\n/g, ' ') || '完成'
                } catch (e) {
                  run.status = 'error'
                  run.resultJson = JSON.stringify({ ok: false, error: (e as Error).message })
                  run.resultSummary = 'MCP 调用失败'
                }
              }
            }
            deps.session.save()
            deps.onChange()
            messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
            continue
          }

          // ★用户记忆：save_user_memory 由 runAgent 特殊处理（追加到 globalStorage user_memory.md，豁免验证闸门）
          if (tname === 'save_user_memory') {
            const mem = String(args.content || '').trim()
            if (!mem) {
              run.status = 'error'
              run.resultJson = JSON.stringify({ ok: false, error: 'content 为空' })
              run.resultSummary = '内容为空'
            } else if (!deps.saveUserMemory) {
              run.status = 'error'
              run.resultJson = JSON.stringify({ ok: false, error: '记忆写入未启用' })
              run.resultSummary = '记忆写入未启用'
            } else {
              try {
                await deps.saveUserMemory(mem)
                run.status = 'done'
                run.resultJson = JSON.stringify({ ok: true })
                run.resultSummary = '已记录到用户记忆'
              } catch (e) {
                run.status = 'error'
                run.resultJson = JSON.stringify({ ok: false, error: (e as Error).message })
                run.resultSummary = '记录失败'
              }
            }
            deps.session.save()
            deps.onChange()
            messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
            continue
          }

          // ★计划确认：submit_plan 由 runAgent 特殊处理（复用审批通道，方案全文作为问题展示）
          if (tname === 'submit_plan') {
            const plan = String(args.plan || '').trim()
            if (!plan) {
              run.status = 'error'
              run.resultJson = JSON.stringify({ ok: false, error: 'submit_plan 缺少 plan 参数' })
              run.resultSummary = '缺少方案内容'
            } else {
              hooks.setStatus('awaiting')
              const apr = await deps.requestApproval({
                toolName: 'submit_plan', argsSummary: plan, kind: 'ask',
                options: ['批准执行', '取消任务'],
              })
              if (apr.decision === 'allow' && (apr.reason === '批准执行' || !apr.reason)) {
                planApproved = true
                run.status = 'done'
                run.resultJson = JSON.stringify({ ok: true, note: '方案已获用户批准，现在可以开始执行写/命令类操作' })
                run.resultSummary = '方案已获用户批准'
              } else if (apr.decision === 'allow') {
                // 用户选择了自定义输入（修改意见），不批准但把意见反馈给模型修订
                run.status = 'error'
                run.resultJson = JSON.stringify({ ok: false, feedback: apr.reason, recovery: '用户对方案有修改意见（见 feedback），请修订方案后重新调用 submit_plan' })
                run.resultSummary = '用户要求修改方案'
              } else {
                run.status = 'rejected'
                run.resultJson = JSON.stringify({ ok: false, error: `用户取消了任务（${apr.reason || '未说明'}）` })
                run.resultSummary = '用户取消任务'
              }
            }
            deps.session.save()
            deps.onChange()
            messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
            continue
          }

          // ★技能加载：load_skill 由 runAgent 特殊处理（直接读 SkillsStore，内容作为工具结果进入上下文）
          if (tname === 'load_skill') {
            const rawName = String(args.name || '').trim()
            // ★交付闸门：冒烟已通过后，禁止再加载规划类技能（writing-plans/brainstorming 等），强制直接交付
            const deliveryReady = modifiedPaths.size > 0 && lastVerifyRound >= lastModifyRound
            const PLANNING_SKILLS = /writing-plans|brainstorming|test-driven-development|code-review|plan-mode|spec-mode/i
            if (deliveryReady && PLANNING_SKILLS.test(rawName)) {
              run.status = 'done'
              run.resultJson = JSON.stringify({ ok: true, name: rawName, note: '冒烟验证已通过、功能已闭环，无需再加载规划类技能。请立即输出最终交付汇报（修改内容/验证方式/当前状态），不要继续规划。' })
              run.resultSummary = `交付闸门：跳过「${rawName}」`
              messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
              deps.session.save()
              deps.onChange()
              continue
            }
            // vendor 技能附属文件（如 references/xxx.md）；个人技能不用此参数
            const vendorFile = args.file ? String(args.file).trim() : undefined
            const fileName = rawName.endsWith('.md') ? rawName : `${rawName}.md`
            let loaded = false

            // 1) 个人技能优先（现有技能库；读不到则落到 vendor）
            if (deps.skills && !vendorFile) {
              const pkey = `personal:${fileName}`
              if (loadedSkills.has(pkey)) {
                run.status = 'done'
                run.resultJson = JSON.stringify({ ok: true, name: rawName, note: '该技能已加载过，完整内容见上文工具结果，请勿重复加载' })
                run.resultSummary = `技能「${rawName}」已加载过`
                loaded = true
              } else {
                try {
                  const content = await deps.skills.read(fileName)
                  loadedSkills.add(pkey)
                  run.status = 'done'
                  run.resultJson = JSON.stringify({ ok: true, name: rawName, content })
                  run.resultSummary = `已加载技能「${rawName}」`
                  loaded = true
                } catch { /* 个人技能不存在，继续尝试 vendor */ }
              }
            }

            // 2) Superpowers 内置技能（英文目录名；file 参数可读 references 等附属文件）
            if (!loaded) {
              const vendorName = rawName.replace(/\.md$/, '')
              if (!deps.skills || !deps.superpowers) {
                run.status = 'error'
                run.resultJson = JSON.stringify({ ok: false, error: `技能不存在或不可读: ${rawName}`, recovery: '从系统提示的技能索引中选择存在的名称重试' })
                run.resultSummary = '技能不存在'
              } else {
                const vkey = `vendor:${vendorName}:${vendorFile || 'SKILL.md'}`
                if (loadedSkills.has(vkey)) {
                  run.status = 'done'
                  run.resultJson = JSON.stringify({ ok: true, name: vendorName, file: vendorFile, note: '该文件已加载过，内容见上文工具结果，请勿重复加载' })
                  run.resultSummary = `「${vendorName}」已加载过`
                } else {
                  try {
                    const content = await deps.skills.readVendor(vendorName, vendorFile)
                    loadedSkills.add(vkey)
                    run.status = 'done'
                    run.resultJson = JSON.stringify({ ok: true, name: vendorName, file: vendorFile, content })
                    run.resultSummary = vendorFile
                      ? `已加载「${vendorName}/${vendorFile}」`
                      : `已加载 Superpowers 技能「${vendorName}」`
                    // 流程闸门兼容：进入头脑风暴/计划技能即接管规划纪律，不再强制 todo_write 先行
                    if (!vendorFile && (vendorName === 'brainstorming' || vendorName === 'writing-plans')) {
                      markPlanned()
                    }
                  } catch (e) {
                    run.status = 'error'
                    run.resultJson = JSON.stringify({ ok: false, error: `技能不存在或不可读: ${vendorName}${vendorFile ? `/${vendorFile}` : ''}（${(e as Error).message}）`, recovery: '从系统提示的 Superpowers 技能索引中选择存在的名称重试' })
                    run.resultSummary = '技能不存在'
                  }
                }
              }
            }
            deps.session.save()
            deps.onChange()
            messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
            continue
          }

          // ★子代理工具：spawn_task / await_task 由 runAgent 特殊处理（不走 executeToolCall）
          if (call.function.name === 'spawn_task' || call.function.name === 'await_task') {
            if (!deps.subAgents) {
              run.status = 'error'
              run.resultJson = JSON.stringify({ ok: false, error: '子代理管理器未初始化' })
              run.resultSummary = '子代理不可用'
            } else if (call.function.name === 'spawn_task') {
              const taskDesc = String(args.task || '')
              const allowedTools = Array.isArray(args.tools) ? args.tools.map(String) : undefined
              const sub = deps.subAgents.spawn(taskDesc, allowedTools)
              if (sub.status === 'error') {
                run.status = 'error'
                run.resultJson = JSON.stringify({ ok: false, error: sub.error })
                run.resultSummary = sub.error || '启动失败'
              } else {
                run.status = 'done'
                run.resultJson = JSON.stringify({ ok: true, task_id: sub.id, status: 'running' })
                run.resultSummary = `子任务 ${sub.id} 已启动`
              }
            } else {
              const taskId = String(args.task_id || '')
              const timeout = Math.min(Number(args.timeout) || 120_000, 300_000)
              const sub = await deps.subAgents.await(taskId, timeout, token)
              run.status = sub.status === 'done' ? 'done' : sub.status === 'timeout' ? 'error' : 'error'
              run.resultJson = JSON.stringify({ ok: sub.status === 'done', status: sub.status, result: sub.result, error: sub.error })
              run.resultSummary = sub.status === 'done'
                ? `子任务完成：${(sub.result || '').slice(0, 60)}`
                : `子任务${sub.status === 'timeout' ? '超时' : '出错'}：${sub.error || ''}`
            }
            deps.session.save()
            deps.onChange()
            messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
            continue
          }

          // ★先读后改提示：修改已存在的文件前建议先 read_file，但不阻止执行
          if (tname === 'read_file') readPaths.add(normPath(args.path))
          if ((tname === 'edit_file' || tname === 'write_file' || tname === 'edit_notebook') && args.path) {
            const np = normPath(args.path)
            let exists = false
            if (folder) {
              try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, String(args.path))); exists = true } catch { exists = false }
            }
            if (exists && !readPaths.has(np)) {
              // 不再阻止执行，仅在结果中追加提醒
              readPaths.add(np) // 标记已读避免重复提醒
            }
          }

          const rawResult = await executeToolWithTimeout(call, hooks, deps.toolDeps)
          const toolResult = truncateToolResult(run.name, withFileNotFoundHint(rawResult))
          run.status = toolResult.ok
            ? 'done'
            : String(toolResult.error || '').startsWith('用户拒绝') ? 'rejected' : 'error'
          run.resultJson = JSON.stringify(toolResult)
          run.resultSummary = summarizeResult(run.name, toolResult)
          // 追踪修改与验证，供收尾前的验证闸门判断
          if (toolResult.ok) {
            if (tname === 'write_file' || tname === 'edit_file' || tname === 'delete_file' || tname === 'edit_notebook') {
              roundHadProgress = true
              const np = normPath(args.path)
              // .agent/memory.md 是记忆沉淀，不算代码修改，不触发验证闸门
              if (!np.endsWith('.agent\\memory.md')) {
                modifiedPaths.add(np)
                lastModifyRound = round
              }
              // 文件刚由本会话写入/改完，其最新内容模型已知，后续 edit 不再要求先读
              if (tname === 'write_file' || tname === 'edit_file') readPaths.add(np)
            } else if (tname === 'run_command' || tname === 'read_lints' || tname === 'await_shell') {
              lastVerifyRound = round
            }
          }
          // 执行了命令（即使失败）也算在行动，不算分析瘫痪
          if (tname === 'run_command' || tname === 'await_shell') roundHadProgress = true
          // 规划与探索类工具本身是有价值的推进（强模型前期会充分规划后才动手），
          // 不应被计为"零进展"而触发分析瘫痪误判
          if (tname === 'todo_write' || tname === 'submit_plan' || tname === 'load_skill'
            || tname === 'read_file' || tname === 'search_files' || tname === 'list_dir' || tname === 'read_lints') {
            roundHadProgress = true
          }
          // ★ 错误记忆沉淀：追踪"未匹配错误 → 模型编辑 → 验证成功"链路
          const errStr = String(toolResult.error || '')
          if (tname === 'run_command' && !toolResult.ok && !errStr.includes('[错误自愈')) {
            // 命令失败且未被规则引擎处理 → 记录待学习的错误
            const cmd = String(args.command || '')
            pendingLearn = { stderr: errStr.slice(0, 2000), cmd, fixFiles: new Set() }
          } else if (toolResult.ok && pendingLearn) {
            if (tname === 'write_file' || tname === 'edit_file') {
              // 模型在错误后编辑了文件 → 计入修复步骤
              pendingLearn.fixFiles.add(normPath(args.path))
            } else if ((tname === 'run_command' || tname === 'await_shell') && pendingLearn.fixFiles.size > 0) {
              // 编辑后命令验证成功 → 沉淀学习规则
              const fixDesc = `修改文件 ${[...pendingLearn.fixFiles].join('、')} 后重新执行 ${pendingLearn.cmd.split('\n')[0].slice(0, 60)}`
              const learned = ErrorPatternMatcher.getInstance().depositCandidate(
                pendingLearn.stderr, pendingLearn.cmd, fixDesc, projectRoot
              )
              if (learned) {
                run.resultSummary = `${run.resultSummary}（已沉淀错误修复经验，下次同类报错可参考）`
              }
              pendingLearn = null
            }
          }
          deps.session.save()
          deps.onChange()

          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolResult) })
        } catch (e) {
          // 兜底：意外异常落为该 run 的 error 痕迹与 tool 消息，模型下轮可自我修复，回合不被杀
          const errMsg = `工具执行异常: ${(e as Error).message}`
          if (run) {
            run.status = 'error'
            run.resultJson = JSON.stringify({ ok: false, error: errMsg })
            run.resultSummary = '执行异常'
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: errMsg }) })
          deps.session.save()
          deps.onChange()
        }
      }
      // 本轮有修改/命令执行/规划/探索则清零停滞计数；全空转（空回复/被拦/退化循环）则累积
      stagnantActionRounds = roundHadProgress ? 0 : stagnantActionRounds + 1
      stagnantTotal = roundHadProgress ? 0 : stagnantTotal + 1
      deps.session.save()
      // Level 3：措辞催办与宿主求真均未带来进展，硬上限熔断，避免无限烧时间
      // 无产物阶段用更宽松的阈值（强模型前期规划合理），有产物后用紧阈值（不验证=真瘫痪）
      const hardLimit = modifiedPaths.size > 0 ? STAGNANT_HARD_LIMIT_WITH_PRODUCT : STAGNANT_HARD_LIMIT_NO_PRODUCT
      if (stagnantTotal >= hardLimit) {
        stoppedReason = 'stagnant'
        break
      }
    }
    if (stoppedReason === 'stagnant') {
      const fileList = modifiedPaths.size
        ? [...modifiedPaths].slice(0, 10).join('\n- ')
        : '（无产物文件）'
      const verified = lastVerifyRound >= lastModifyRound && modifiedPaths.size > 0
      deps.session.add({
        role: 'assistant',
        content: [
          '任务因连续无进展已自动停止（系统熔断，已达到停滞硬上限）。为避免继续空转烧时间，现如实汇报当前真实状态：',
          '',
          `【修改内容】已产出文件：\n- ${fileList}`,
          '',
          `【验证方式】系统/模型执行状态：${verified ? '已完成验证（最近一轮验证通过）' : '未完成有效验证'}。`,
          '',
          '【当前状态】模型反复停留在读取/分析阶段，系统已分别尝试措辞催办与自动验证注入，仍未能继续推进。建议：发送「继续」并补充更具体的指示，或人工接手处理上述文件中可能存在的问题。',
        ].join('\n'),
        time: deps.session.now(),
      })
    }
    deps.onChange()
  } catch (e) {
    vscode.window.showErrorMessage(`Codex CN 内部错误: ${(e as Error).message}`)
  } finally {
    // 任务结束（含中途取消/异常）：给最后一轮 assistant 消息盖结束时间戳，供时间线展示耗时
    if (lastAssistantMsg) {
      lastAssistantMsg.endTs = Date.now()
      deps.session.save()
    }
  }
}
