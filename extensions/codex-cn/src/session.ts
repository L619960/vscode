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
    this.messages.push(msg)
    this.persist()
    return msg
  }

  /** 更新当前消息（流式后落盘） */
  save(): void {
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
