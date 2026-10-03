// MCP 客户端：stdio（Content-Length 帧，兼容官方 SDK）与 Streamable HTTP 两种传输
// JSON-RPC 2.0；支持 initialize → tools/list → tools/call；多服务器由 McpManager 聚合
import { spawn, type ChildProcess } from 'child_process'

export type McpTransport = 'stdio' | 'http'

export interface McpServerConfig {
  /** 传输类型，缺省按 command 存在与否推断 */
  type?: McpTransport
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // http
  url?: string
}

export interface McpToolInfo {
  server: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpServerStatus {
  name: string
  status: 'connecting' | 'connected' | 'error'
  error: string
  toolCount: number
  tools: Array<{ name: string; description: string }>
  config: McpServerConfig
}

interface JsonRpcResponse {
  jsonrpc: string
  id?: number | string
  result?: unknown
  error?: { code: number; message: string }
}

const CLIENT_INFO = { name: 'codex-cn', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

/** 把服务器返回的原始工具清单归一化为 McpToolInfo */
function mapTools(serverName: string, rawTools: unknown): McpToolInfo[] {
  const list = Array.isArray(rawTools) ? rawTools : []
  return list.map((t: any) => ({
    server: serverName,
    name: String(t.name),
    description: String(t.description || ''),
    inputSchema: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
  }))
}

/** 统一客户端接口（stdio / http） */
export interface IMcpClient {
  readonly serverName: string
  tools: McpToolInfo[]
  lastError: string
  connect(timeoutMs?: number): Promise<void>
  callTool(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  dispose(): void
}

/** 单个 MCP 服务器的 stdio 连接 */
export class McpStdioClient implements IMcpClient {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private frameBuf = ''
  tools: McpToolInfo[] = []
  lastError = ''

  constructor(readonly serverName: string, private cfg: McpServerConfig) { }

  async connect(timeoutMs = 30000): Promise<void> {
    const command = this.cfg.command ?? ''
    // Windows 下 npx 等实际是 .cmd，需 shell 才能解析；shell 模式下参数由 Node 加引号
    this.proc = spawn(command, this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    this.proc.on('error', (e) => { this.lastError = e.message; this.failAll(e) })
    this.proc.stderr?.on('data', () => { /* MCP server 日志走 stderr，忽略 */ })
    this.proc.stdout?.on('data', (chunk) => this.onChunk(String(chunk)))
    this.proc.on('exit', () => this.failAll(new Error('MCP 服务器进程已退出')))

    // initialize 握手
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, timeoutMs)
    this.notify('notifications/initialized', {})

    // 拉取工具清单
    const list = await this.rpc('tools/list', {}, timeoutMs) as { tools?: unknown }
    this.tools = mapTools(this.serverName, list.tools)
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<unknown> {
    const result = await this.rpc('tools/call', { name: toolName, arguments: args }, timeoutMs) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    // MCP 返回 content 数组，提取 text 拼接
    const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
    if (result.isError) throw new Error(text || 'MCP 工具执行失败')
    return text || result
  }

  dispose(): void {
    this.failAll(new Error('MCP 连接已关闭'))
    try { this.proc?.kill() } catch { /* 忽略 */ }
    this.proc = null
  }

  /** 解析输入：兼容 Content-Length 分帧（官方 SDK）与 NDJSON（新版协议）两种格式 */
  private onChunk(chunk: string): void {
    this.frameBuf += chunk
    while (true) {
      if (this.frameBuf.startsWith('{')) {
        // NDJSON：读到换行即一条
        const nl = this.frameBuf.indexOf('\n')
        if (nl === -1) return
        const line = this.frameBuf.slice(0, nl).trim()
        this.frameBuf = this.frameBuf.slice(nl + 1)
        if (line) this.dispatch(line)
        continue
      }
      // Content-Length 帧
      const headerEnd = this.frameBuf.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.frameBuf.slice(0, headerEnd)
      const m = /content-length:\s*(\d+)/i.exec(header)
      if (!m) { this.frameBuf = this.frameBuf.slice(headerEnd + 4); continue }
      const len = Number(m[1])
      const bodyStart = headerEnd + 4
      if (this.frameBuf.length - bodyStart < len) return
      const body = this.frameBuf.slice(bodyStart, bodyStart + len)
      this.frameBuf = this.frameBuf.slice(bodyStart + len)
      this.dispatch(body)
    }
  }

  private dispatch(raw: string): void {
    let msg: JsonRpcResponse
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.id === undefined || typeof msg.id !== 'number') return
    const p = this.pendingRpc.get(msg.id)
    if (!p) return
    this.pendingRpc.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`))
    else p.resolve(msg.result)
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) throw new Error(`MCP 服务器 ${this.serverName} 未连接`)
    // 新版协议 stdio 用 NDJSON（官方 SDK v2 不再认 Content-Length 帧）；读取端两种帧都兼容
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  private rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id)
        reject(new Error(`MCP ${method} 超时（${timeoutMs / 1000}s）`))
      }, timeoutMs)
      this.pendingRpc.set(id, { resolve, reject, timer })
      try { this.send({ jsonrpc: '2.0', id, method, params }) }
      catch (e) { this.pendingRpc.delete(id); clearTimeout(timer); reject(e) }
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    try { this.send({ jsonrpc: '2.0', method, params }) } catch { /* 忽略 */ }
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pendingRpc) { clearTimeout(p.timer); p.reject(e) }
    this.pendingRpc.clear()
  }
}

/** 单个 MCP 服务器的 Streamable HTTP 连接（响应支持单 JSON 与 SSE） */
export class McpHttpClient implements IMcpClient {
  private nextId = 1
  private sessionId: string | null = null
  tools: McpToolInfo[] = []
  lastError = ''

  constructor(readonly serverName: string, private cfg: McpServerConfig) { }

  async connect(timeoutMs = 15000): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, timeoutMs)
    // HTTP 传输没有独立 initialized 通知端点，直接 POST 通知
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, true)
    const list = await this.rpc('tools/list', {}, timeoutMs) as { tools?: unknown }
    this.tools = mapTools(this.serverName, list.tools)
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<unknown> {
    const result = await this.rpc('tools/call', { name: toolName, arguments: args }, timeoutMs) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
    if (result.isError) throw new Error(text || 'MCP 工具执行失败')
    return text || result
  }

  dispose(): void {
    this.sessionId = null
  }

  /** 发 JSON-RPC；notification=true 时不等响应 */
  private async rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    return this.post({ jsonrpc: '2.0', id, method, params }, false, timeoutMs)
  }

  private async post(body: Record<string, unknown>, isNotification: boolean, timeoutMs = 15000): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(this.cfg.url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const sid = resp.headers.get('Mcp-Session-Id')
      if (sid) this.sessionId = sid
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)
      if (isNotification) return undefined
      const contentType = resp.headers.get('content-type') ?? ''
      const text = await resp.text()
      const msg: JsonRpcResponse = contentType.includes('text/event-stream')
        ? this.parseSse(text)
        : JSON.parse(text)
      if (msg.error) throw new Error(`MCP ${msg.error.code}: ${msg.error.message}`)
      return msg.result
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error(`MCP 请求超时（${timeoutMs / 1000}s）`)
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  /** 从 SSE 响应中取最后一条 data 消息（JSON-RPC 响应） */
  private parseSse(text: string): JsonRpcResponse {
    let last: JsonRpcResponse | undefined
    for (const block of text.split(/\r?\n\r?\n/)) {
      const dataLines = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
      if (!dataLines.length) continue
      try { last = JSON.parse(dataLines.join('\n')) } catch { /* 跳过 */ }
    }
    if (!last) throw new Error('MCP HTTP 服务器返回的 SSE 中无有效响应')
    return last
  }
}

/** 多服务器聚合管理器：连接、状态跟踪、热增删/重连，汇总工具清单并路由调用 */
export class McpManager {
  private clients = new Map<string, IMcpClient>()
  /** 合成工具名（mcp__server__tool）→ 原始信息 */
  private toolMap = new Map<string, McpToolInfo>()
  private cfgs = new Map<string, McpServerConfig>()
  private statuses = new Map<string, McpServerStatus>()

  /** 推断传输类型：显式 type 优先，否则有 url 走 http，其余走 stdio */
  private resolveTransport(cfg: McpServerConfig): McpTransport {
    if (cfg.type) return cfg.type
    if (cfg.url && !cfg.command) return 'http'
    return 'stdio'
  }

  /** 连接所有配置的服务器；失败的记录状态，不阻断启动 */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<string[]> {
    const errors: string[] = []
    this.cfgs = new Map(Object.entries(servers))
    await Promise.all([...this.cfgs.entries()].map(async ([name, cfg]) => {
      const err = await this.connectOne(name, cfg)
      if (err) errors.push(err)
    }))
    return errors
  }

  /** 连接单个服务器；返回错误描述（成功为 ''），并更新状态 */
  private async connectOne(name: string, cfg: McpServerConfig): Promise<string> {
    const transport = this.resolveTransport(cfg)
    const status: McpServerStatus = {
      name, status: 'connecting', error: '', toolCount: 0, tools: [], config: cfg,
    }
    this.statuses.set(name, status)
    this.clients.get(name)?.dispose()
    this.clients.delete(name)
    const client: IMcpClient = transport === 'http'
      ? new McpHttpClient(name, cfg)
      : new McpStdioClient(name, cfg)
    if (transport === 'stdio' && !cfg.command) {
      status.status = 'error'
      status.error = 'stdio 服务器缺少 command'
      return `${name}: stdio 服务器缺少 command`
    }
    if (transport === 'http' && !cfg.url) {
      status.status = 'error'
      status.error = 'http 服务器缺少 url'
      return `${name}: http 服务器缺少 url`
    }
    try {
      await client.connect()
      this.clients.set(name, client)
      this.toolMap.forEach((v, k) => { if (v.server === name) this.toolMap.delete(k) })
      for (const t of client.tools) this.toolMap.set(`mcp__${name}__${t.name}`, t)
      status.status = 'connected'
      status.toolCount = client.tools.length
      status.tools = client.tools.map(t => ({ name: t.name, description: t.description }))
      return ''
    } catch (e) {
      const err = (e as Error).message
      client.dispose()
      status.status = 'error'
      status.error = err
      return `${name}: ${err}`
    }
  }

  /** 热新增/更新：断开旧连接 → 用新配置重连 */
  async upsert(name: string, cfg: McpServerConfig): Promise<string> {
    this.cfgs.set(name, cfg)
    return this.connectOne(name, cfg)
  }

  /** 热移除：断开连接并清除状态与工具 */
  remove(name: string): void {
    this.cfgs.delete(name)
    this.clients.get(name)?.dispose()
    this.clients.delete(name)
    this.statuses.delete(name)
    this.toolMap.forEach((v, k) => { if (v.server === name) this.toolMap.delete(k) })
  }

  /** 重连指定服务器（配置已存在时） */
  async reconnect(name: string): Promise<string> {
    const cfg = this.cfgs.get(name)
    if (!cfg) return `${name}: 配置不存在`
    return this.connectOne(name, cfg)
  }

  /** 全部服务器状态快照 */
  list(): McpServerStatus[] {
    return [...this.cfgs.keys()].map(n => this.statuses.get(n) ?? {
      name: n, status: 'error' as const, error: '未连接', toolCount: 0, tools: [], config: this.cfgs.get(n)!,
    })
  }

  /** 状态行摘要：🟢 6/6 MCP 已连接 或 🟡 3/6 连接中 或 🔴 2/6 失败 */
  statusLine(): string {
    const all = this.list()
    const total = all.length
    if (!total) return ''
    const ok = all.filter(s => s.status === 'connected').length
    const err = all.filter(s => s.status === 'error').length
    if (ok === total) return `🟢 ${ok}/${total} MCP 已连接`
    if (err === total) return `🔴 ${ok}/${total} MCP 连接失败`
    return `🟡 ${ok}/${total} MCP 连接中`
  }

  /** 转成 OpenAI function-calling schema 列表 */
  toolSchemas(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return [...this.toolMap.values()].map(t => ({
      type: 'function' as const,
      function: {
        name: `mcp__${t.server}__${t.name}`,
        description: `[MCP:${t.server}] ${t.description}`.slice(0, 500),
        parameters: t.inputSchema,
      },
    }))
  }

  has(syntheticName: string): boolean { return this.toolMap.has(syntheticName) }

  async call(syntheticName: string, args: Record<string, unknown>): Promise<unknown> {
    const info = this.toolMap.get(syntheticName)
    if (!info) throw new Error(`未知 MCP 工具: ${syntheticName}`)
    const client = this.clients.get(info.server)
    if (!client) throw new Error(`MCP 服务器 ${info.server} 未连接`)
    return client.callTool(info.name, args)
  }

  dispose(): void {
    for (const c of this.clients.values()) c.dispose()
    this.clients.clear()
    this.toolMap.clear()
    this.statuses.clear()
  }
}
