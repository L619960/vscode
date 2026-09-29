// 子 Agent 管理器：spawn_task / await_task 的后端实现
// 子 Agent 拥有独立上下文（不共享主会话消息），并行上限 2，结果聚合回传主循环

import * as vscode from 'vscode'
import { chatCompletion } from './llm.js'
import { getLLMConfig } from './config.js'
import { TOOL_SCHEMAS } from './tools.js'
import { executeToolCall, type ExecHooks, type ToolDeps } from './executor.js'
import { buildSystemPrompt } from './prompt.js'
import type { ChatMessage } from './types.js'

export interface SubTask {
  id: string
  task: string
  status: 'running' | 'done' | 'error' | 'timeout' | 'cancelled'
  result?: string
  error?: string
  startedAt: number
  finishedAt?: number
}

export class SubAgentManager {
  private tasks = new Map<string, SubTask>()
  private running = 0
  private readonly MAX_PARALLEL = 4
  private readonly DEFAULT_TIMEOUT = 300_000
  private readonly MAX_ROUNDS = 100

  constructor(
    private readonly getApiKey: () => Promise<string>,
    private readonly toolDeps: ToolDeps,
  ) {}

  /** 当前运行中的子 Agent 数 */
  get activeCount(): number { return this.running }

  /** 启动子 Agent（立即返回 task_id，不阻塞） */
  spawn(taskDesc: string, allowedTools?: string[]): SubTask {
    if (this.running >= this.MAX_PARALLEL) {
      return { id: '', task: taskDesc, status: 'error', error: `并行子 Agent 已达上限（${this.MAX_PARALLEL}）`, startedAt: Date.now() }
    }
    const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const t: SubTask = { id, task: taskDesc, status: 'running', startedAt: Date.now() }
    this.tasks.set(id, t)
    this.running++
    // 异步执行，不阻塞 spawn 调用方
    void this.run(id, taskDesc, allowedTools).finally(() => { this.running-- })
    return t
  }

  /** 等待子 Agent 完成（轮询，可中断） */
  async await(taskId: string, timeoutMs = this.DEFAULT_TIMEOUT, cancelToken?: vscode.CancellationToken): Promise<SubTask> {
    const t = this.tasks.get(taskId)
    if (!t) return { id: taskId, task: '', status: 'error', error: '任务不存在', startedAt: Date.now() }
    const deadline = Date.now() + timeoutMs
    while (t.status === 'running' && Date.now() < deadline) {
      if (cancelToken?.isCancellationRequested) {
        t.status = 'cancelled'
        t.finishedAt = Date.now()
        return t
      }
      await new Promise(r => setTimeout(r, 800))
    }
    if (t.status === 'running') {
      t.status = 'timeout'
      t.finishedAt = Date.now()
    }
    return t
  }

  /** 停止所有子 Agent（主循环取消时调用） */
  stopAll(): void {
    for (const t of this.tasks.values()) {
      if (t.status === 'running') { t.status = 'cancelled'; t.finishedAt = Date.now() }
    }
  }

  private async run(id: string, taskDesc: string, allowedTools?: string[]): Promise<void> {
    const t = this.tasks.get(id)!
    try {
      const apiKey = await this.getApiKey()
      const llmConfig = getLLMConfig(apiKey)
      const tools = allowedTools?.length
        ? TOOL_SCHEMAS.filter(s => allowedTools.includes(s.function.name))
        : TOOL_SCHEMAS

      const systemPrompt = await buildSystemPrompt('子任务', '', '') + `\n\n【子 Agent 模式】你正在执行一个独立的子任务，不共享主会话上下文。任务描述：${taskDesc}\n要求：独立完成，结果精炼（200字以内），不要询问用户。`

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: taskDesc },
      ]

      const abort = new AbortController()
      let finalContent = ''
      let consecutiveErrors = 0

      for (let round = 1; round <= this.MAX_ROUNDS; round++) {
        if (abort.signal.aborted) { t.status = 'cancelled'; break }

        const result = await chatCompletion({
          messages, tools, config: llmConfig, signal: abort.signal,
        })

        if (result.error) {
          consecutiveErrors++
          if (consecutiveErrors >= 3) { t.status = 'error'; t.error = result.error; break }
          messages.push({ role: 'user', content: `[系统] 出错：${result.error}，请重试` })
          continue
        }
        consecutiveErrors = 0

        messages.push({
          role: 'assistant', content: result.content || null,
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        })

        if (result.toolCalls.length === 0) {
          finalContent = result.content || ''
          break
        }

        // 执行工具（子 Agent 无审批，直接执行）
        for (const call of result.toolCalls) {
          if (abort.signal.aborted) break
          const hooks: ExecHooks = {
            setStatus: () => {},
            requestApproval: () => Promise.resolve({ decision: 'allow' }), // 子 Agent 免审批
          }
          const raw = await executeToolCall(call, hooks, this.toolDeps)
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(raw) })
        }
      }

      if (t.status === 'running') {
        t.status = finalContent ? 'done' : 'error'
        t.result = finalContent || '子 Agent 未产生最终结果'
        t.error = finalContent ? undefined : '未产生最终结果'
      }
    } catch (e) {
      t.status = 'error'
      t.error = (e as Error).message
    } finally {
      t.finishedAt = Date.now()
    }
  }
}
