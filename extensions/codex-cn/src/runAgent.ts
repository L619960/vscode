// Agent 主循环：轮次控制、消息组装、中断检查、tool 结果回喂

import * as vscode from 'vscode'
import { chatCompletion } from './llm.js'
import { getLLMConfig } from './config.js'
import { TOOL_SCHEMAS, summarizeArgs, summarizeResult } from './tools.js'
import { executeToolCall, type ApprovalDecision, type ApprovalRequest, type ExecHooks } from './executor.js'
import { buildSystemPrompt } from './prompt.js'
import { Session, type SessionMessage, type ToolRun } from './session.js'
import type { ChatMessage } from './types.js'

const MAX_ROUNDS = 15
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

/** 历史消息字符预算（粗略对应 token 数 × 2，本地小模型上下文有限） */
const CONTEXT_CHAR_BUDGET = 12000

/** 历史 toolRuns 重建为 API wire 消息，超预算时从最早的开始裁剪 */
async function buildApiMessages(session: Session): Promise<ChatMessage[]> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  const wsName = folder?.name || '（无）'
  const dirSummary = await buildDirSummary()
  const systemMsg: ChatMessage = { role: 'system', content: buildSystemPrompt(wsName, dirSummary) }

  // 先把全部历史建出来
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

  // 从后往前累加字符数，超预算时截断（保留最近的对话）
  let chars = 0
  const kept: ChatMessage[] = []
  for (let i = all.length - 1; i >= 0; i--) {
    const msgLen = (typeof all[i].content === 'string' ? (all[i].content as string).length : 0)
      + (all[i].tool_calls?.length ? 500 : 0)
    if (chars + msgLen > CONTEXT_CHAR_BUDGET && kept.length > 0) break
    chars += msgLen
    kept.unshift(all[i])
  }

  return [systemMsg, ...kept]
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
  const messages = await buildApiMessages(deps.session)
  messages.push({ role: 'user', content: userText })

  const abort = new AbortController()
  token.onCancellationRequested(() => abort.abort())

  try {
    let consecutiveErrors = 0
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (token.isCancellationRequested || abort.signal.aborted) return

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
        const toolResult = await executeToolCall(call, hooks)
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
      content: '已达最大轮次（15），已停止。可发送「继续」让 AI 接着执行。',
      time: deps.session.now(),
    })
    deps.onChange()
  } catch (e) {
    vscode.window.showErrorMessage(`Codex CN 内部错误: ${(e as Error).message}`)
  }
}
