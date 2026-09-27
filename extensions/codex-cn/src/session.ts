// 会话：消息结构 + 多会话管理（globalState 持久化）
// 兼容旧版单会话数据（codex-cn.session），首次加载自动迁移。

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

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}
export interface StoredSessionData extends SessionMeta {
  messages: SessionMessage[]
}

const DEFAULT_TITLE = '新会话'

/** 会话运行规则（由管理器从设置实时读取，保证配置变更即时生效） */
export interface SessionRules {
  /** 消息保留条数 */
  maxMessages: number
  /** 自动生成标题 */
  autoTitle: boolean
}

/** 单个会话：消息容器，变更时通过回调通知管理器落盘 */
export class Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: SessionMessage[] = []
  private readonly fire: (s: Session) => void
  private readonly getRules: () => SessionRules

  constructor(data: StoredSessionData, fire: (s: Session) => void, getRules: () => SessionRules) {
    this.id = data.id
    this.title = data.title || DEFAULT_TITLE
    this.createdAt = data.createdAt
    this.updatedAt = data.updatedAt
    this.messages = data.messages || []
    this.fire = fire
    this.getRules = getRules
    // 恢复时把中断的 running/awaiting 标记为 error
    for (const m of this.messages) {
      for (const t of m.toolRuns || []) {
        if (t.status === 'running' || t.status === 'awaiting') {
          t.status = 'error'
          t.resultSummary = '上次会话中断'
        }
      }
    }
    // 恢复时按当前设置裁剪超限消息
    if (this.messages.length > this.getRules().maxMessages) {
      this.messages = this.messages.slice(-this.getRules().maxMessages)
    }
  }

  add(msg: SessionMessage): SessionMessage {
    if (msg.ts === undefined) msg.ts = Date.now()
    this.messages.push(msg)
    if (this.getRules().autoTitle && msg.role === 'user' && this.title === DEFAULT_TITLE) {
      const oneLine = msg.content.replace(/\s+/g, ' ').trim()
      this.title = oneLine.length > 24 ? oneLine.slice(0, 24) + '…' : oneLine
    }
    this.touch()
    return msg
  }

  /** 移除指定消息（用于空响应续跑时撤下空气泡） */
  remove(msg: SessionMessage): void {
    const i = this.messages.indexOf(msg)
    if (i >= 0) { this.messages.splice(i, 1); this.touch() }
  }

  /** 更新当前消息（流式后落盘） */
  save(): void {
    this.touch()
  }

  /** 截断：保留前 n 条消息（含），删除之后的；用于从某条消息回退 */
  truncate(n: number): void {
    this.messages.splice(n + 1)
    this.touch()
  }

  /** 清空当前会话内容（保留会话本身） */
  clear(): void {
    this.messages = []
    this.touch()
  }

  now(): string {
    return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  toJSON(): StoredSessionData {
    return {
      id: this.id, title: this.title,
      createdAt: this.createdAt, updatedAt: this.updatedAt,
      messages: this.messages.slice(-this.getRules().maxMessages),
    }
  }

  private touch(): void {
    this.updatedAt = Date.now()
    this.fire(this)
  }
}

// ---- 多会话管理器 ----

const SESSIONS_KEY = 'codex-cn.sessions.v2'
const ACTIVE_KEY = 'codex-cn.activeSessionId'
const LEGACY_KEY = 'codex-cn.session'

export class SessionManager {
  private readonly memento: vscode.Memento
  private readonly getRules: () => SessionRules
  private readonly getMaxSessions: () => number
  /** 顺序即展示顺序（最近更新在前） */
  private order: string[] = []
  private sessions = new Map<string, Session>()
  activeId: string

  constructor(
    memento: vscode.Memento,
    getRules: () => SessionRules,
    getMaxSessions: () => number,
  ) {
    this.memento = memento
    this.getRules = getRules
    this.getMaxSessions = getMaxSessions

    for (const data of memento.get<StoredSessionData[]>(SESSIONS_KEY, [])) {
      if (!data?.id || this.sessions.has(data.id)) continue
      this.sessions.set(data.id, new Session(data, () => this.persist(), this.getRules))
      this.order.push(data.id)
    }

    // 旧版单会话迁移（仅当没有 v2 数据时）
    if (!this.sessions.size) {
      const legacy = memento.get<SessionMessage[]>(LEGACY_KEY, [])
      if (legacy.length) {
        const migrated = this.createSession(undefined, legacy, Date.now())
        // 用首条用户消息生成标题（add 时才会自动生成，迁移数据需要补一次）
        const firstUser = legacy.find((m) => m.role === 'user')
        if (firstUser) {
          const oneLine = firstUser.content.replace(/\s+/g, ' ').trim()
          migrated.title = oneLine.length > 24 ? oneLine.slice(0, 24) + '…' : oneLine
          migrated.save()
        }
        void memento.update(LEGACY_KEY, undefined)
      }
    }

    if (!this.sessions.size) this.createSession()

    // 恢复后按当前上限淘汰超限的最旧会话
    this.enforceSessionLimit()

    const savedActive = memento.get<string>(ACTIVE_KEY)
    this.activeId = savedActive && this.sessions.has(savedActive) ? savedActive : this.order[0]
  }

  get active(): Session {
    const s = this.sessions.get(this.activeId)
    if (s) return s
    this.activeId = this.order[0]
    return this.sessions.get(this.activeId)!
  }

  /** 会话列表（最近更新在前） */
  list(): SessionMeta[] {
    return this.order.map((id) => {
      const s = this.sessions.get(id)!
      return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt }
    })
  }

  /** 新建会话并切为当前；空标题时不创建（调用方保证） */
  createSession(title?: string, messages: SessionMessage[] = [], createdAt: number = Date.now()): Session {
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
    const now = Date.now()
    const session = new Session(
      { id, title: title || DEFAULT_TITLE, createdAt, updatedAt: now, messages },
      () => this.persist(),
      this.getRules,
    )
    this.sessions.set(id, session)
    this.order.unshift(id)
    this.activeId = id
    // 超出上限：真实删除最旧会话（不只是不落盘）
    this.enforceSessionLimit()
    this.persist()
    return session
  }

  /** 设置变更后立即应用上限（maxSessions 调小时即时淘汰）；返回保留的会话数 */
  applyLimits(): number {
    this.enforceSessionLimit()
    this.persist()
    return this.order.length
  }

  /**
   * 会话上限淘汰：超过 maxSessions 时删除 order 末尾（最旧）的会话。
   * 跳过当前 active（极端情况下宁可保留 active，由下次机会再淘汰）
   */
  private enforceSessionLimit(): void {
    const max = Math.max(1, Math.floor(this.getMaxSessions()))
    while (this.order.length > max) {
      let victim = -1
      for (let i = this.order.length - 1; i >= 0; i--) {
        if (this.order[i] !== this.activeId) { victim = i; break }
      }
      if (victim === -1) return
      const [removed] = this.order.splice(victim, 1)
      this.sessions.delete(removed)
    }
  }

  /** 打开历史会话 */
  open(id: string): Session | null {
    if (!this.sessions.has(id)) return null
    this.activeId = id
    // 提到最前
    const i = this.order.indexOf(id)
    if (i > 0) { this.order.splice(i, 1); this.order.unshift(id) }
    this.persist()
    return this.sessions.get(id)!
  }

  /** 删除会话；删除的是当前会话时自动切到相邻会话（无则新建） */
  remove(id: string): Session {
    this.sessions.delete(id)
    const i = this.order.indexOf(id)
    if (i >= 0) this.order.splice(i, 1)

    if (this.activeId === id || !this.sessions.size) {
      if (!this.sessions.size) {
        this.createSession()
      } else {
        this.activeId = this.order[Math.max(0, i - 1)]
      }
    }
    this.persist()
    return this.active
  }

  private persist(): void {
    const max = Math.max(1, Math.floor(this.getMaxSessions()))
    const data = this.order
      .slice(0, max)
      .map((id) => this.sessions.get(id)?.toJSON())
      .filter((d): d is StoredSessionData => !!d)
    void this.memento.update(SESSIONS_KEY, data)
    void this.memento.update(ACTIVE_KEY, this.activeId)
  }
}
