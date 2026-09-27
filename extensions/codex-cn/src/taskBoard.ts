// AI 任务规划板：todo_write 的状态存储（globalState 持久化）

import * as vscode from 'vscode'

export interface TaskCheckpoint {
  label: string
  priority: 'P0' | 'P1'
  status: 'done' | 'running' | 'error'
  evidence?: string
  remark?: string
}

const KEY = 'codex-cn.taskboard'

export class TaskBoard {
  items: TaskCheckpoint[] = []
  private readonly state: vscode.Memento

  constructor(state: vscode.Memento) {
    this.state = state
    this.items = state.get<TaskCheckpoint[]>(KEY, [])
  }

  /** 全量替换（todo_write 语义），返回统计 */
  replace(items: TaskCheckpoint[]): { total: number; p0: number; done: number; running: number; error: number } {
    this.items = items.slice(0, 100)
    void this.state.update(KEY, this.items)
    return {
      total: this.items.length,
      p0: this.items.filter((i) => i.priority === 'P0').length,
      done: this.items.filter((i) => i.status === 'done').length,
      running: this.items.filter((i) => i.status === 'running').length,
      error: this.items.filter((i) => i.status === 'error').length,
    }
  }

  clear(): void {
    this.items = []
    void this.state.update(KEY, [])
  }
}
