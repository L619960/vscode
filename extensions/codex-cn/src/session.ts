// 会话状态：消息结构 + VS Code globalState 持久化 + 变更通知

import * as vscode from 'vscode'

export interface ToolRun {
  id: string
  name: string
  argsSummary: string
  argsJson: string
  status: 'running' | 'awaiting' | 'done' | 'error' | 'rejected'
  resultJson: string
  resultSummary: string
}
export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  time: string
  /** 消息创建的毫秒时间戳（任务耗时统计用） */
  ts?: number
  /** 该消息所属 Agent 任务结束的毫秒时间戳（盖在最后一轮 assistant 消息上） */
  endTs?: number
  toolRuns?: ToolRun[]
}

const KEY = 'codex-cn.session'
const MAX_MESSAGES = 100

export class Session {
  messages: SessionMessage[] = []
  private readonly state: vscode.Memento

  constructor(state: vscode.Memento) {
    this.state = state
    this.messages = state.get<SessionMessage[]>(KEY, [])
    // 恢复时把中断的 running/awaiting 标记为 error
    for (const m of this.messages) {
      for (const t of m.toolRuns || []) {
        if (t.status === 'running' || t.status === 'awaiting') {
          t.status = 'error'
          t.resultSummary = '上次会话中断'
        }
      }
    }
  }

  private persist(): void {
    const slice = this.messages.slice(-MAX_MESSAGES)
    void this.state.update(KEY, slice)
  }

  add(msg: SessionMessage): SessionMessage {
    if (msg.ts === undefined) msg.ts = Date.now()
    this.messages.push(msg)
    this.persist()
    return msg
  }

  /** 移除指定消息（用于空响应续跑时撤下空气泡） */
  remove(msg: SessionMessage): void {
    const i = this.messages.indexOf(msg)
    if (i >= 0) this.messages.splice(i, 1)
  }

  /** 更新当前消息（流式后落盘） */
  save(): void {
    this.persist()
  }

  /** 截断：保留前 n 条消息（含），删除之后的；用于从某条消息回退 */
  truncate(n: number): void {
    this.messages.splice(n + 1)
    this.persist()
  }

  clear(): void {
    this.messages = []
    this.persist()
  }

  now(): string {
    return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
}
