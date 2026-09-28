// MCP Client：stdio 传输的 JSON-RPC 2.0 客户端（无第三方 SDK 依赖）
// 支持 initialize → tools/list → tools/call；多服务器由 McpManager 聚合
import { spawn, type ChildProcess } from 'child_process'
import * as readline from 'readline'

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpToolInfo {
  server: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: string
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

const CLIENT_INFO = { name: 'codex-cn', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

/** 单个 MCP 服务器的 stdio 连接 */
export class McpClient {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  tools: McpToolInfo[] = []
  /** 连接失败时记录原因，管理器据此跳过 */
  lastError = ''

  constructor(readonly serverName: string, private cfg: McpServerConfig) { }

  async connect(timeoutMs = 15000): Promise<void> {
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.proc.on('error', (e) => { this.lastError = e.message; this.failAll(e) })
    this.proc.stderr?.on('data', () => { /* MCP server 日志走 stderr，忽略 */ })
    const rl = readline.createInterface({ input: this.proc.stdout! })
    rl.on('line', (line) => this.onLine(line))

    // initialize 握手
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, timeoutMs)
    this.notify('notifications/initialized', {})

    // 拉取工具清单
    const list = await this.rpc('tools/list', {}, timeoutMs) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }
    this.tools = (list.tools ?? []).map(t => ({
      server: this.serverName,
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }))
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

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: JsonRpcResponse
    try { msg = JSON.parse(trimmed) } catch { return }
    if (msg.id === undefined) return // 通知/请求无需处理
    const p = this.pendingRpc.get(msg.id)
    if (!p) return
    this.pendingRpc.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`))
    else p.resolve(msg.result)
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) throw new Error(`MCP 服务器 ${this.serverName} 未连接`)
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

/** 多服务器聚合管理器：连接全部配置的 MCP server，汇总工具清单，路由调用 */
export class McpManager {
  private clients = new Map<string, McpClient>()
  /** 合成工具名（mcp__server__tool）→ 原始信息 */
  private toolMap = new Map<string, McpToolInfo>()

  /** 连接所有配置的服务器；失败的记录原因并跳过，不阻断启动 */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<string[]> {
    const errors: string[] = []
    await Promise.all(Object.entries(servers).map(async ([name, cfg]) => {
      const client = new McpClient(name, cfg)
      try {
        await client.connect()
        this.clients.set(name, client)
        for (const t of client.tools) this.toolMap.set(`mcp__${name}__${t.name}`, t)
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`)
        client.dispose()
      }
    }))
    return errors
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
  }
}
