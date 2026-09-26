// Agent 主循环：轮次控制、消息组装、中断检查、tool 结果回喂

import * as vscode from 'vscode'
import { chatCompletion } from './llm.js'
import { getLLMConfig } from './config.js'
import { TOOL_SCHEMAS, summarizeArgs, summarizeResult } from './tools.js'
import { executeToolCall, type ApprovalDecision, type ApprovalRequest, type ExecHooks } from './executor.js'
import { buildSystemPrompt } from './prompt.js'
import { Session, type SessionMessage, type ToolRun } from './session.js'
import type { ChatMessage, ToolCall } from './types.js'

const MAX_ROUNDS = 50
/** 连续 LLM 错误上限：超过则终止任务，避免死循环 */
const MAX_CONSECUTIVE_ERRORS = 3

/** 由扩展实现：审批桥（原生弹窗+Diff）与 webview 状态推送 */
export interface AgentDeps {
  session: Session
  getApiKey(): Promise<string>
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>
  onChange(): void
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

/** 带超时执行工具：超时返回错误结果而不是挂死主循环 */
async function executeToolWithTimeout(call: ToolCall, hooks: ExecHooks): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      executeToolCall(call, hooks),
      new Promise<Record<string, unknown>>((resolve) => {
        timer = setTimeout(() => {
          resolve({ ok: false, error: `工具执行超过 ${TOOL_TIMEOUT_MS / 1000} 秒已超时。请缩小操作范围或换一种方式重试` })
        }, TOOL_TIMEOUT_MS)
      }),
    ])
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

  const abort = new AbortController()
  token.onCancellationRequested(() => abort.abort())

  try {
    let consecutiveErrors = 0
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (token.isCancellationRequested || abort.signal.aborted) return

      // 每轮开始前压缩一次历史，防止长任务中上下文无限膨胀
      messages = compressHistory(messages)

      const assistantMsg: SessionMessage = deps.session.add({
        role: 'assistant', content: '', time: deps.session.now(), toolRuns: [],
      })
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
        // 把错误回喂给 AI 作为 tool 结果，让它理解并修正
        messages.push({ role: 'user', content: `[系统] 上一次请求出错：${result.error}。请重试或调整方式。` })
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
        deps.session.save()
        deps.onChange()
        return
      }

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
          // JSON 解析失败：不执行工具，直接把错误回喂给 AI
          run.status = 'error'
          run.resultJson = JSON.stringify({ ok: false, error: argsParseError })
          run.resultSummary = '参数 JSON 解析失败'
          deps.session.save()
          deps.onChange()
          messages.push({ role: 'tool', tool_call_id: call.id, content: run.resultJson })
          continue
        }

        const hooks: ExecHooks = {
          setStatus: (s) => { run.status = s as ToolRun['status']; deps.onChange() },
          requestApproval: (req) => deps.requestApproval(req),
        }
        const rawResult = await executeToolWithTimeout(call, hooks)
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
  }
}
