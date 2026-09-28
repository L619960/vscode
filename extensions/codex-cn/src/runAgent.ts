// Agent 主循环：轮次控制、消息组装、中断检查、tool 结果回喂

import * as vscode from 'vscode'
import { chatCompletion } from './llm.js'
import { getLLMConfig } from './config.js'
import { TOOL_SCHEMAS, WRITE_TOOLS, summarizeArgs, summarizeResult } from './tools.js'
import { executeToolCall, type ApprovalDecision, type ApprovalRequest, type ExecHooks, type ToolDeps } from './executor.js'
import { SubAgentManager } from './subAgent.js'
import { buildSystemPrompt } from './prompt.js'
import { Session, type SessionMessage, type ToolRun } from './session.js'
import type { TaskBoard, TaskCheckpoint } from './taskBoard.js'
import type { ChatMessage, ToolCall } from './types.js'

const MAX_ROUNDS = 200
/** 连续 LLM 错误上限：超过则终止任务，避免死循环 */
const MAX_CONSECUTIVE_ERRORS = 3
/** 连续空回复（无内容无工具调用）上限：空回复不终止，自动催办继续，超限才停止 */
const MAX_EMPTY_RESPONSES = 3

/** 截断恢复指令：明确禁止重复巨型调用，强制骨架+分批 edit 工作流 */
const TRUNCATION_RECOVERY = [
  '上一次工具调用因参数内容过长，在生成中途被截断（JSON 不完整，服务端无法解析）。',
  '注意：重复同样的一次性写法必然再次失败，必须立即改为分批写入：',
  '1. 现在只用 write_file 写入不超过 150 行的可运行骨架（imports、类与函数签名、主界面/主流程结构），未实现的函数体用 pass 或带唯一标记的占位行（如 # TODO: 功能名）；',
  '2. 然后连续调用多次 edit_file，每批定位一个占位锚点，填充 100-150 行实现；',
  '3. 重复第 2 步直到功能完整，最后通读自查。',
  '现在只输出第 1 步的 write_file 骨架调用，不要输出完整实现。',
].join('\n')

/** write_file 单次行数硬上限：模型提示词遵循不稳定，用代码兜底防截断 */
const WRITE_FILE_MAX_LINES = 300
/** edit_file 单批 replace 行数硬上限 */
const EDIT_BATCH_MAX_LINES = 250

/**
 * 写类工具规模硬约束：超限时不执行，直接返回错误引导分批写入。
 * 提示词规则对量化模型约束不可靠（实测 227/278 行均超限），必须代码兜底
 */
function enforceWriteSizePolicy(name: string, args: Record<string, unknown>): string {
  if (name === 'write_file') {
    const n = String(args.content ?? '').split('\n').length
    if (n > WRITE_FILE_MAX_LINES) {
      return `write_file 内容 ${n} 行，超过单次 ${WRITE_FILE_MAX_LINES} 行硬上限——继续生成必然在中途截断。`
        + '请立即改为：write_file 写不超过 150 行骨架（函数体用 pass/# TODO 占位），再多次 edit_file 每批填充 100-150 行。'
    }
  }
  if (name === 'edit_file' && Array.isArray(args.edits)) {
    for (let i = 0; i < args.edits.length; i++) {
      const ed = args.edits[i] as Record<string, unknown>
      const n = String(ed?.replace ?? '').split('\n').length
      if (n > EDIT_BATCH_MAX_LINES) {
        return `edit_file 第 ${i + 1} 个替换内容 ${n} 行，超过单批 ${EDIT_BATCH_MAX_LINES} 行硬上限，请拆成多个 edit 或分多轮调用。`
      }
    }
  }
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
  return lines.join('\n').slice(0, 3000)
}

/** 历史压缩阈值（字符数）：超过则把早期消息折叠为摘要，而不是硬截断 */
const COMPRESS_THRESHOLD = 15000
/** 压缩时保留最近的消息条数（约 4 组 user/assistant 交互） */
const KEEP_RECENT_MESSAGES = 8

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

/** 历史 toolRuns 重建为 API wire 消息，超出字符阈值时压缩早期记录 */
async function buildApiMessages(session: Session): Promise<ChatMessage[]> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  const wsName = folder?.name || '（无）'
  const dirSummary = await buildDirSummary()
  const systemPrompt = await buildSystemPrompt(wsName, dirSummary, folder?.uri.fsPath)
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

/** 单个工具结果长度上限（字符），超过则智能截断 */
const TOOL_RESULT_MAX = 2000

/**
 * 超长工具结果智能截断：
 * - read_file / run_command：保留前 50 行
 * - search_files：保留前 20 条匹配
 * - 其他：截断超长字符串字段
 */
function truncateToolResult(name: string, result: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(result).length <= TOOL_RESULT_MAX) return result

  if (name === 'read_file' && typeof result.content === 'string') {
    const text = result.content as string
    const lines = text.split('\n')
    const content = lines.length > 50
      ? lines.slice(0, 50).join('\n') + `\n... (truncated，共 ${lines.length} 行，可用 start_line/end_line 分段继续读取)`
      : text.slice(0, TOOL_RESULT_MAX) + '\n... (truncated)'
    return { ...result, content, truncated: true }
  }

  if (name === 'search_files' && Array.isArray(result.matches) && result.matches.length > 20) {
    return {
      ...result,
      matches: result.matches.slice(0, 20),
      truncated: true,
      note: `仅保留前 20 条匹配（共 ${result.matches.length} 条），请缩小搜索范围或换更精确的关键字`,
    }
  }

  if (name === 'run_command') {
    const out: Record<string, unknown> = { ...result }
    for (const key of ['stdout', 'stderr']) {
      const v = out[key]
      if (typeof v !== 'string' || v.length <= TOOL_RESULT_MAX / 2) continue
      const lines = v.split('\n')
      out[key] = lines.length > 50
        ? lines.slice(0, 50).join('\n') + `\n... (truncated，共 ${lines.length} 行)`
        : v.slice(0, TOOL_RESULT_MAX / 2) + '\n... (truncated)'
    }
    return out
  }

  // 兜底：截断超长字符串字段
  const out: Record<string, unknown> = { ...result }
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.length > TOOL_RESULT_MAX) {
      out[k] = v.slice(0, TOOL_RESULT_MAX) + '\n... (truncated)'
    }
  }
  return out
}

/** 单个工具执行超时（毫秒） */
const TOOL_TIMEOUT_MS = 30000

/** 带超时执行工具：超时返回错误结果而不是挂死主循环。
 *  等待人工审批期间暂停计时（审批可无限期等待，人工决定优先于机器超时）。 */
async function executeToolWithTimeout(call: ToolCall, hooks: ExecHooks, deps: ToolDeps): Promise<Record<string, unknown>> {
  const n = call.function?.name || ''
  const limit = n === 'await_shell' ? 70000 : n.startsWith('browser_') ? 50000 : TOOL_TIMEOUT_MS
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
  let messages = await buildApiMessages(deps.session)
  const folder = vscode.workspace.workspaceFolders?.[0]
  const resolvedText = folder ? await resolveAtReferences(userText, folder.uri.fsPath) : userText
  messages.push({ role: 'user', content: resolvedText })

  // 用户消息入会话：作为时间线回合的边界，并在 UI 上显示提问原文
  deps.session.add({ role: 'user', content: userText, time: deps.session.now() })
  deps.onChange()

  const abort = new AbortController()
  token.onCancellationRequested(() => abort.abort())

  let lastAssistantMsg: SessionMessage | undefined
  // 流程闸门：本任务是否已通过 todo_write 完成需求拆解
  let didPlan = false
  try {
    let consecutiveErrors = 0
    let consecutiveEmpty = 0
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (token.isCancellationRequested || abort.signal.aborted) return

      // 每轮开始前压缩一次历史，防止长任务中上下文无限膨胀
      messages = compressHistory(messages)

      const assistantMsg: SessionMessage = deps.session.add({
        role: 'assistant', content: '', time: deps.session.now(), toolRuns: [],
      })
      lastAssistantMsg = assistantMsg
      deps.onChange()

      const result = await chatCompletion({
        messages,
        tools: TOOL_SCHEMAS,
        config: llmConfig,
        signal: abort.signal,
        onToken: (t) => {
          assistantMsg.content += t
          deps.onChange()
        },
        onDegraded: () => {
          assistantMsg.content += '> ⚠ 当前模型不支持工具调用，已自动切换纯对话模式\n'
        },
      })

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
        deps.session.save()
        deps.onChange()
        return
      }
      consecutiveEmpty = 0

      for (const call of result.toolCalls) {
        if (token.isCancellationRequested || abort.signal.aborted) { deps.session.save(); return }

        let args: Record<string, unknown> = {}
        let argsParseError = ''
        try { args = JSON.parse(call.function.arguments || '{}') } catch (e) {
          argsParseError = `工具参数 JSON 解析失败: ${(e as Error).message}。原始参数: ${(call.function.arguments || '').slice(0, 200)}`
        }
        const run: ToolRun = {
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
          setStatus: (s) => { run.status = s as ToolRun['status']; deps.onChange() },
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
        if (tname === 'todo_write') didPlan = true
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

        // ★检查点催办：每 5 轮检查一次，有 running 状态超过 10 轮的检查点时提醒更新
        if (round % 5 === 0 && round > 0 && deps.taskBoard) {
          const pending = deps.taskBoard.items.filter((i: TaskCheckpoint) => i.status === 'running')
          if (pending.length > 0) {
            const names = pending.map((i: TaskCheckpoint) => i.label).slice(0, 3).join('、')
            const reminder = `[系统提醒] 任务规划中有 ${pending.length} 个检查点仍处于运行状态（如：${names}）。请及时调用 todo_write 更新已完成的检查点状态，或继续推进任务。`
            messages.push({ role: 'user', content: reminder })
            // 不中断当前工具执行，仅追加提醒
          }
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

        const rawResult = await executeToolWithTimeout(call, hooks, deps.toolDeps)
        const toolResult = truncateToolResult(run.name, withFileNotFoundHint(rawResult))
        run.status = toolResult.ok
          ? 'done'
          : String(toolResult.error || '').startsWith('用户拒绝') ? 'rejected' : 'error'
        run.resultJson = JSON.stringify(toolResult)
        run.resultSummary = summarizeResult(run.name, toolResult)
        deps.session.save()
        deps.onChange()

        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolResult) })
      }
    }
    deps.session.add({
      role: 'assistant',
      content: `已达最大轮次（${MAX_ROUNDS}），已停止。可发送「继续」让 AI 接着执行。`,
      time: deps.session.now(),
    })
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
