// Codex CN 扩展入口：Webview View + 编辑器标签页 + Agent 桥 + 审批 / vscode.diff

import * as vscode from 'vscode'
import { Session, SessionManager } from './session.js'
import { runAgent, type AgentDeps } from './runAgent.js'
import { getApiKey, saveApiKey, getProvider, applyProviderPreset, setConfig, getLLMConfig, getAgentSettings, PROVIDER_PRESETS } from './config.js'
import { chatCompletion } from './llm.js'
import { registerTabCompletion } from './tabCompletion.js'
import { registerInlineEdit } from './inlineEdit.js'
import { getCheckpoints, restoreCheckpoint, clearCheckpoints } from './checkpoints.js'
import { TaskBoard } from './taskBoard.js'
import { BackgroundShell } from './backgroundShell.js'
import { BrowserSession } from './browser.js'
import { SkillsStore } from './skills.js'
import { SubAgentManager } from './subAgent.js'
import { McpManager, type McpServerConfig } from './mcp.js'
import type { ApprovalDecision, ApprovalRequest } from './executor.js'

let session: Session
let manager: SessionManager
let cancelSource: vscode.CancellationTokenSource | null = null

// 待审批请求：id → resolve
const pending = new Map<string, (d: ApprovalDecision) => void>()
// 会话级免审批工具集合
const autoApproved = new Set<string>()

/** Diff 内容供应器：把审批的 old/new 内容用自定义 scheme 暴露给 vscode.diff */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>()
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? ''
  }
  put(uri: vscode.Uri, content: string): void { this.contents.set(uri.toString(), content) }
}
const diffProvider = new DiffContentProvider()

/** 提示词优化的系统指令（只输出改写后的提示词本身） */
const PROMPT_OPTIMIZER_SYSTEM = `你是「提示词优化」助手。用户会给你一段原始的编程任务描述，请改写成更清晰、具体、易执行的提示词。
要求：
1. 保持用户的原始意图与语言（中文输入则输出中文）。
2. 补全隐含的目标、约束与验收标准，但不虚构用户未提出的需求。
3. 结构清晰，可适当分点；篇幅不要明显超过原文。
4. 只输出优化后的提示词本身，不要任何解释、前缀或引号。`

function activate(context: vscode.ExtensionContext): void {
  manager = new SessionManager(
    context.globalState,
    () => {
      const s = getAgentSettings()
      return { maxMessages: s.maxMessages, autoTitle: s.autoTitle }
    },
    () => getAgentSettings().maxSessions,
  )
  session = manager.active

  // 技能库：globalStorage/skills 真实 .md 文件 + 扩展内置 vendor/superpowers 技能
  const vendorRoot = vscode.Uri.joinPath(context.extensionUri, 'vendor', 'superpowers', 'skills')
  const skills = new SkillsStore(context.globalStorageUri, vendorRoot)
  void skills.ensure()

  // 跨会话用户记忆：globalStorage/user_memory.md（一行一条偏好，注入系统提示词）
  const userMemUri = vscode.Uri.joinPath(context.globalStorageUri, 'user_memory.md')
  const getUserMemory = async (): Promise<string> => {
    try {
      const buf = await vscode.workspace.fs.readFile(userMemUri)
      return Buffer.from(buf).toString('utf8').slice(0, 2000)
    } catch { return '' }
  }
  const saveUserMemory = async (content: string): Promise<void> => {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri)
    let existing = ''
    try { existing = Buffer.from(await vscode.workspace.fs.readFile(userMemUri)).toString('utf8') } catch { /* 首次写入 */ }
    const line = content.trim().replace(/\n+/g, '；')
    const entry = line.startsWith('- ') ? line : `- ${line}`
    const next = existing ? `${existing.replace(/\s+$/, '')}\n${entry}\n` : `# 用户记忆（跨会话）\n\n${entry}\n`
    await vscode.workspace.fs.writeFile(userMemUri, Buffer.from(next, 'utf8'))
  }

  // 有状态工具依赖：任务规划板 / 后台 Shell / 内置浏览器
  const board = new TaskBoard(context.globalState)
  const bgShell = new BackgroundShell()
  const browser = new BrowserSession()

  // MCP 客户端：连接 codex-cn.mcpServers 配置的外部工具服务器（失败跳过不阻断启动）
  const mcp = new McpManager()
  const mcpServers = vscode.workspace.getConfiguration('codex-cn').get<Record<string, McpServerConfig>>('mcpServers', {})
  if (Object.keys(mcpServers).length > 0) {
    void mcp.connectAll(mcpServers).then(errors => {
      if (errors.length > 0) {
        void vscode.window.showWarningMessage(`Codex CN: 部分 MCP 服务器连接失败：${errors.join('；')}`)
      }
    })
  }
  context.subscriptions.push({ dispose: () => { bgShell.dispose(); browser.dispose(); mcp.dispose() } })

  // 启动时自动在右侧辅助栏聚焦 Agent 聊天面板（Cursor 式默认布局）
  // workbench.view.extension.<container> 打开并聚焦容器；codex-cn.chat.focus 聚焦聊天视图
  // 辅助栏可见性由 VS Code 持久化管理：用户展开一次后，后续启动辅助栏自动展开，chat 自动可见
  // 若用户手动关闭了辅助栏（宽度 0），先切换展开再聚焦
  void vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar').then(() => {
    void vscode.commands.executeCommand('workbench.view.extension.codex-cn').then(
      () => void vscode.commands.executeCommand('codex-cn.chat.focus'),
      () => void vscode.commands.executeCommand('codex-cn.chat.focus')
    )
  })

  registerTabCompletion(context)

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('codexcn-diff', diffProvider)
  )

  // Ctrl+K 行内编辑：复用 codexcn-diff 供应器做修改预览
  registerInlineEdit(context, diffProvider)

  const openDiff = (req: ApprovalRequest): void => {
    const left = vscode.Uri.parse(`codexcn-diff:///${req.path || 'file'}?old&t=${Date.now()}`)
    const right = vscode.Uri.parse(`codexcn-diff:///${req.path || 'file'}?new&t=${Date.now()}`)
    diffProvider.put(left, req.oldContent ?? '')
    diffProvider.put(right, req.newContent ?? '')
    void vscode.commands.executeCommand('vscode.diff', left, right, `Codex CN: ${req.path || '文件变更'}`)
  }

  // 所有 webview 出口（侧栏视图 + 编辑器标签页）：状态统一广播，保证多处一致
  const sinks = new Set<vscode.Webview>()
  const postToWebview = (msg: unknown): void => {
    for (const w of sinks) void w.postMessage(msg)
  }

  // 审批桥：用户明确要求——所有工具命令（包括危险命令）全部自动放行，不弹审批
  const requestApproval = (_req: ApprovalRequest): Promise<ApprovalDecision> => {
    return Promise.resolve({ decision: 'allow', auto: true })
  }

  // 统一状态推送：消息 + 运行状态 + 检查点 + 规划 + 会话列表
  const postState = (extra: Record<string, unknown> = {}): void => {
    postToWebview({
      type: 'state',
      messages: session.messages,
      running: cancelSource !== null,
      checkpoints: getCheckpoints().length,
      todos: board.items,
      sessions: manager.list(),
      activeId: manager.activeId,
      ...extra,
    })
  }

  // 子 Agent 管理器：spawn_task / await_task 的后端
  const subAgents = new SubAgentManager(() => getApiKey(context.secrets), { board, bgShell, browser })
  context.subscriptions.push({ dispose: () => { subAgents.stopAll() } })

  // 停止当前 Agent 任务：取消 token + 按拒绝释放全部待审批 + 停掉全部子 Agent
  const stopAgent = (): void => {
    cancelSource?.cancel()
    cancelSource = null
    subAgents.stopAll()
    for (const [id, resolve] of pending) { resolve({ decision: 'deny', reason: '用户停止了任务' }); pending.delete(id) }
    postState({ running: false })
  }

  const send = async (text: string): Promise<void> => {
    if (cancelSource) return
    cancelSource = new vscode.CancellationTokenSource()
    postState({ running: true })
    const deps: AgentDeps = {
      session,
      getApiKey: () => getApiKey(context.secrets),
      requestApproval,
      onChange: () => postState(),
      toolDeps: { board, bgShell, browser },
      subAgents,
      taskBoard: board,
      skills,
      mcp,
      planMode: vscode.workspace.getConfiguration('codex-cn').get<boolean>('planMode', false),
      superpowers: vscode.workspace.getConfiguration('codex-cn').get<boolean>('superpowers', false),
      getUserMemory,
      saveUserMemory,
    }
    await runAgent(text, deps, cancelSource.token)
    cancelSource = null
    postState({ running: false })
  }

  // 新建会话：先停止正在运行的任务，再创建并跳转（当前为空会话时不重复创建）
  const newSession = (): void => {
    if (cancelSource) stopAgent()
    if (!session.messages.length) return
    session = manager.createSession()
    board.replace([])
    clearCheckpoints()
    postState()
  }

  // 切换会话：先停止当前任务（运行中的 Agent 绑定旧会话），再实时切换
  const openSessionById = (id: string): void => {
    if (cancelSource) stopAgent()
    const opened = manager.open(id)
    if (!opened) return
    session = opened
    board.replace([])
    postState()
  }

  const deleteSessionById = (id: string): void => {
    if (cancelSource) stopAgent()
    session = manager.remove(id)
    board.replace([])
    postState()
  }

  // 回滚：弹出快照列表（最新在前），选中后恢复对应文件
  const rollback = async (): Promise<void> => {
    const list = getCheckpoints()
    if (!list.length) {
      void vscode.window.showInformationMessage('暂无可回滚的快照')
      return
    }
    const items = list.map((cp, index) => ({
      label: cp.file,
      description: new Date(cp.timestamp).toLocaleTimeString('zh-CN'),
      detail: cp.content === '' ? '快照时文件不存在，回滚将删除该文件' : '恢复该文件到快照时的内容',
      index,
    })).reverse()
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要恢复的快照（仅恢复对应文件）' })
    if (!picked) return
    try {
      await restoreCheckpoint(picked.index)
      void vscode.window.showInformationMessage(`已回滚：${picked.label}`)
    } catch (e) {
      void vscode.window.showErrorMessage(`回滚失败: ${(e as Error).message}`)
    }
  }

  const getConfig = async (): Promise<unknown> => {
    const c = vscode.workspace.getConfiguration('codex-cn')
    const key = await getApiKey(context.secrets)
    const s = getAgentSettings()
    return {
      provider: c.get('provider'), baseUrl: c.get('baseUrl'), model: c.get('model'),
      supportsTools: c.get('supportsTools'), autoApprove: c.get('autoApprove'), planMode: c.get('planMode'), superpowers: c.get('superpowers'), tabCompletion: c.get('tabCompletion'), hasKey: !!key,
      // 工具开关 / 隐私 / 对话流
      toolRead: s.toolRead, toolWrite: s.toolWrite, toolShell: s.toolShell,
      toolBrowser: s.toolBrowser, toolWeb: s.toolWeb, privacyMode: s.privacyMode,
      maxMessages: s.maxMessages, autoTitle: s.autoTitle, maxSessions: s.maxSessions,
      presets: Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([k, v]) => [k, v.label])),
      presetModels: Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([k, v]) => [k, v.model])),
    }
  }

  type ConfigPatch = {
    provider?: string; baseUrl?: string; model?: string; supportsTools?: string
    autoApprove?: boolean; planMode?: boolean; superpowers?: boolean; tabCompletion?: boolean; apiKey?: string
    toolRead?: boolean; toolWrite?: boolean; toolShell?: boolean; toolBrowser?: boolean; toolWeb?: boolean
    privacyMode?: boolean; maxMessages?: number; autoTitle?: boolean; maxSessions?: number
  }
  const saveConfig = async (patch: ConfigPatch): Promise<void> => {
    let providerChanged = false
    if (patch.provider && patch.provider !== getProvider()) {
      providerChanged = true
      await setConfig({ provider: patch.provider })
      await applyProviderPreset(patch.provider)
    }
    const rest: Parameters<typeof setConfig>[0] = {}
    if (patch.baseUrl !== undefined) rest.baseUrl = patch.baseUrl
    if (patch.model !== undefined) rest.model = patch.model
    if (patch.supportsTools !== undefined) rest.supportsTools = patch.supportsTools
    if (patch.autoApprove !== undefined) rest.autoApprove = patch.autoApprove
    if (patch.planMode !== undefined) rest.planMode = patch.planMode
    if (patch.superpowers !== undefined) rest.superpowers = patch.superpowers
    if (patch.tabCompletion !== undefined) rest.tabCompletion = patch.tabCompletion
    if (patch.toolRead !== undefined) rest.toolRead = patch.toolRead
    if (patch.toolWrite !== undefined) rest.toolWrite = patch.toolWrite
    if (patch.toolShell !== undefined) rest.toolShell = patch.toolShell
    if (patch.toolBrowser !== undefined) rest.toolBrowser = patch.toolBrowser
    if (patch.toolWeb !== undefined) rest.toolWeb = patch.toolWeb
    if (patch.privacyMode !== undefined) rest.privacyMode = patch.privacyMode
    if (patch.maxMessages !== undefined) rest.maxMessages = patch.maxMessages
    if (patch.autoTitle !== undefined) rest.autoTitle = patch.autoTitle
    if (patch.maxSessions !== undefined) rest.maxSessions = patch.maxSessions
    if (Object.keys(rest).length) await setConfig(rest)
    if (patch.apiKey) await saveApiKey(context.secrets, patch.apiKey)
    // 切换提供商：预填的 baseUrl/model 需回传 webview 刷新表单，否则用户看到的是旧值
    if (providerChanged) void postToWebview({ type: 'config', data: await getConfig() })
    // 会话上限调小：立即淘汰并广播最新会话列表
    if (patch.maxSessions !== undefined || patch.maxMessages !== undefined) {
      manager.applyLimits()
      postState()
    }
  }

  const onDecision = (d: { id: string; decision: 'allow' | 'deny' | 'always'; reason?: string; viewDiff?: boolean; req: ApprovalRequest }): void => {
    if (d.viewDiff) { openDiff(d.req); return }
    const resolve = pending.get(d.id)
    if (!resolve) return
    if (d.decision === 'always') { autoApproved.add(d.req.toolName) }
    resolve({ decision: d.decision === 'deny' ? 'deny' : 'allow', reason: d.reason })
    pending.delete(d.id)
  }

  // 提示词优化：调用当前模型改写输入，结果只回传给发起请求的 webview
  const optimizePrompt = async (webview: vscode.Webview, text: string): Promise<void> => {
    const reply = (payload: Record<string, unknown>): void => { void webview.postMessage({ type: 'promptOptimized', ...payload }) }
    if (!text.trim()) return
    const apiKey = await getApiKey(context.secrets)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 60_000)
    try {
      const r = await chatCompletion({
        messages: [
          { role: 'system', content: PROMPT_OPTIMIZER_SYSTEM },
          { role: 'user', content: text },
        ],
        config: getLLMConfig(apiKey),
        signal: ac.signal,
      })
      if (r.error) { reply({ error: r.error }); return }
      const optimized = (r.content || '').trim()
      if (!optimized) { reply({ error: '模型返回为空' }); return }
      reply({ text: optimized })
    } finally {
      clearTimeout(timer)
    }
  }

  // MCP 配置持久化：读出现有 mcpServers → 变更 → 写回用户设置（全局）
  const persistMcpServers = async (
    mut: (servers: Record<string, McpServerConfig>) => void,
  ): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('codex-cn')
    const servers = { ...cfg.get<Record<string, McpServerConfig>>('mcpServers', {}) }
    mut(servers)
    await cfg.update('mcpServers', servers, vscode.ConfigurationTarget.Global)
  }

  // ---- Webview 消息统一处理：侧栏视图与编辑器标签页共用 ----
  const handleMessage = async (webview: vscode.Webview, msg: any): Promise<void> => {
    switch (msg.type) {
      case 'ready':
        void webview.postMessage({
          type: 'state', messages: session.messages,
          running: cancelSource !== null, checkpoints: getCheckpoints().length,
          todos: board.items, sessions: manager.list(), activeId: manager.activeId,
        })
        break
      case 'send': await send(String(msg.text || '')); break
      case 'stop': stopAgent(); break
      case 'clear':
        session.clear()
        clearCheckpoints()
        board.clear()
        postState({ running: false, checkpoints: 0, todos: [] })
        break
      case 'newSession': newSession(); break
      case 'openSession': openSessionById(String(msg.id)); break
      case 'deleteSession': deleteSessionById(String(msg.id)); break
      case 'listSessions':
        void webview.postMessage({ type: 'sessions', sessions: manager.list(), activeId: manager.activeId })
        break
      case 'truncateMessages':
        session.truncate(Number(msg.index))
        postState()
        break
      case 'getConfig': void webview.postMessage({ type: 'config', data: await getConfig() }); break
      case 'openSettings': void vscode.commands.executeCommand('codex-cn.openSettingsTab'); break
      case 'openSettingsTab': void vscode.commands.executeCommand('codex-cn.openSettingsTab'); break
      case 'openFile': {
        // 聊天里的文件路径链接：绝对路径直接开，相对路径拼工作区
        const p = String(msg.path || '')
        if (!p) break
        const isAbs = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
        const root = vscode.workspace.workspaceFolders?.[0]?.uri
        const uri = isAbs ? vscode.Uri.file(p) : root ? vscode.Uri.joinPath(root, p) : vscode.Uri.file(p)
        void vscode.window.showTextDocument(uri, { preview: true }).then(undefined, () => {
          void vscode.window.showWarningMessage(`无法打开文件: ${p}`)
        })
        break
      }
      case 'saveConfig':
        await saveConfig(msg.patch)
        void webview.postMessage({ type: 'configSaved', seq: msg.seq })
        // 广播设置变更（聊天页的模型状态等同步刷新）
        postState()
        break
      case 'fetchModels': {
        // 测试 API 地址：请求 OpenAI 兼容的 /models 端点，返回可用模型 id 列表
        // 注意：部分服务（如火山引擎 Coding Plan）不实现 /models，404 时提示手动填写
        const rawUrl = String(msg.baseUrl || '').trim().replace(/\/+$/, '')
        if (!rawUrl) {
          void webview.postMessage({ type: 'modelsList', seq: msg.seq, error: '请先填写 API 地址' })
          break
        }
        const url = /\/models?$/i.test(rawUrl) ? rawUrl : `${rawUrl}/models`
        const key = await getApiKey(context.secrets)
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 10000)
          const headers: Record<string, string> = { 'Accept': 'application/json' }
          if (key) headers['Authorization'] = `Bearer ${key}`
          const resp = await fetch(url, { headers, signal: controller.signal })
          clearTimeout(timer)
          if (!resp.ok) {
            if (resp.status === 404) {
              // /models 未实现：尝试用预设模型名测试 /chat/completions 是否可用
              const presetModel = String(msg.model || '').trim()
              if (presetModel) {
                void webview.postMessage({ type: 'modelsList', seq: msg.seq, models: [presetModel], note: '该服务未提供模型列表，已使用当前填写的模型名' })
              } else {
                void webview.postMessage({ type: 'modelsList', seq: msg.seq, error: '该服务未提供模型列表接口（404），请手动填写模型名称后保存' })
              }
            } else {
              void webview.postMessage({ type: 'modelsList', seq: msg.seq, error: `服务返回 ${resp.status} ${resp.statusText}` })
            }
            break
          }
          const data = await resp.json() as { data?: Array<{ id?: string }> }
          const ids = Array.isArray(data.data)
            ? data.data.map((m) => m?.id).filter((x): x is string => typeof x === 'string' && x.length > 0)
            : []
          if (!ids.length) {
            void webview.postMessage({ type: 'modelsList', seq: msg.seq, error: '接口未返回任何模型（响应缺少 data 列表）' })
            break
          }
          void webview.postMessage({ type: 'modelsList', seq: msg.seq, models: ids })
        } catch (e) {
          const reason = (e as Error).name === 'AbortError' ? '请求超时（10 秒无响应），请确认 API 地址可达' : `连接失败：${(e as Error).message}`
          void webview.postMessage({ type: 'modelsList', seq: msg.seq, error: reason })
        }
        break
      }
      case 'setAgentMode': {
        const supportsTools = msg.mode === 'chat' ? 'no' : 'auto'
        await setConfig({ supportsTools })
        break
      }
      case 'rollback': await rollback(); break
      case 'optimizePrompt': await optimizePrompt(webview, String(msg.text || '')); break
      case 'decision': onDecision(msg); break
      case 'getWorkspaceFiles': {
        const folder = vscode.workspace.workspaceFolders?.[0]
        if (!folder) {
          void webview.postMessage({ type: 'workspaceFiles', seq: msg.seq, files: [] })
          break
        }
        // 去掉 glob 特殊字符，防止查询串破坏匹配模式
        const query = String(msg.query || '').replace(/[*?{}\[\]\\]/g, '').slice(0, 100)
        // 含 / 时按路径前缀匹配；否则同时匹配文件名与目录名（目录下的文件用于推导目录候选）
        const pattern = query
          ? query.includes('/') ? `**/${query}*` : `{**/*${query}*,**/*${query}*/**}`
          : '**/*'
        const rawFiles = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 50)
        const skipRe = /(^|[\\/])(node_modules|\.git|dist|out)([\\/]|$)/i
        const files: string[] = []
        const dirs = new Set<string>()
        const q = query.toLowerCase()
        for (const f of rawFiles) {
          const rel = vscode.workspace.asRelativePath(f, false).replace(/\\/g, '/')
          if (skipRe.test(rel)) continue
          files.push(rel)
          // 目录前缀也作为候选，支持 @文件夹/ 引用
          const parts = rel.split('/')
          let prefix = ''
          for (let i = 0; i < parts.length - 1; i++) {
            prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
            if (q && !prefix.toLowerCase().includes(q) && !q.startsWith(prefix.toLowerCase() + '/')) continue
            dirs.add(prefix + '/')
          }
        }
        const list = [...dirs, ...files].slice(0, 50)
        void webview.postMessage({ type: 'workspaceFiles', seq: msg.seq, files: list })
        break
      }
      // ---- 技能库：全部操作真实落盘到 globalStorage/skills ----
      case 'listSkills': {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        try {
          if (wsRoot) {
            void webview.postMessage({ type: 'skills', seq: msg.seq, items: await skills.listWithStatus(wsRoot) })
          } else {
            void webview.postMessage({ type: 'skills', seq: msg.seq, items: await skills.list() })
          }
        } catch (e) { void webview.postMessage({ type: 'skills', seq: msg.seq, error: (e as Error).message }) }
        break
      }
      case 'readSkill':
        try { void webview.postMessage({ type: 'skillContent', seq: msg.seq, name: msg.name, content: await skills.read(String(msg.name)) }) }
        catch (e) { void webview.postMessage({ type: 'skillContent', seq: msg.seq, error: (e as Error).message }) }
        break
      case 'createSkill':
        try {
          await skills.create(String(msg.name))
          postToWebview({ type: 'skillsChanged' })
          void webview.postMessage({ type: 'skillChanged', seq: msg.seq })
        }
        catch (e) { void webview.postMessage({ type: 'skillChanged', seq: msg.seq, error: (e as Error).message }) }
        break
      case 'saveSkill':
        try {
          await skills.save(String(msg.name), String(msg.content))
          postToWebview({ type: 'skillsChanged' })
          void webview.postMessage({ type: 'skillChanged', seq: msg.seq })
        }
        catch (e) { void webview.postMessage({ type: 'skillChanged', seq: msg.seq, error: (e as Error).message }) }
        break
      case 'deleteSkill':
        try {
          await skills.remove(String(msg.name))
          postToWebview({ type: 'skillsChanged' })
          void webview.postMessage({ type: 'skillChanged', seq: msg.seq })
        }
        catch (e) { void webview.postMessage({ type: 'skillChanged', seq: msg.seq, error: (e as Error).message }) }
        break
      case 'linkSkills': {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        try {
          if (wsRoot) {
            await skills.linkSkills(wsRoot, msg.names as string[])
            void webview.postMessage({ type: 'skillsLinked', seq: msg.seq })
          } else {
            void webview.postMessage({ type: 'skillsLinked', seq: msg.seq, error: '无工作区，无法关联技能' })
          }
        } catch (e) { void webview.postMessage({ type: 'skillsLinked', seq: msg.seq, error: (e as Error).message }) }
        break
      }
      case 'unlinkSkills': {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        try {
          if (wsRoot) {
            await skills.unlinkSkills(wsRoot, msg.names as string[])
            void webview.postMessage({ type: 'skillsLinked', seq: msg.seq })
          } else {
            void webview.postMessage({ type: 'skillsLinked', seq: msg.seq, error: '无工作区，无法取消关联' })
          }
        } catch (e) { void webview.postMessage({ type: 'skillsLinked', seq: msg.seq, error: (e as Error).message }) }
        break
      }
      // ---- MCP 服务器管理：列表 / 新增更新 / 移除 / 重连（热生效，立即写入用户设置） ----
      case 'mcpList':
        void webview.postMessage({ type: 'mcpList', seq: msg.seq, servers: mcp.list() })
        break
      case 'mcpUpsert': {
        const name = String(msg.name || '').trim()
        const cfg0 = (msg.config ?? {}) as McpServerConfig
        try {
          if (!name) throw new Error('服务器名称不能为空')
          // 归一化：按传输类型清掉无关字段，args 空串过滤
          const isHttp = (cfg0.type ?? (cfg0.url && !cfg0.command ? 'http' : 'stdio')) === 'http'
          const cfg: McpServerConfig = isHttp
            ? { type: 'http', url: String(cfg0.url || '').trim() }
            : {
              type: 'stdio',
              command: String(cfg0.command || '').trim(),
              args: (cfg0.args ?? []).map(a => String(a)).filter(a => a.length > 0),
              env: cfg0.env && Object.keys(cfg0.env).length ? cfg0.env : undefined,
            }
          if (isHttp && !cfg.url) throw new Error('HTTP 服务器必须填写 URL')
          if (!isHttp && !cfg.command) throw new Error('stdio 服务器必须填写命令')
          await persistMcpServers(servers => { servers[name] = cfg })
          const err = await mcp.upsert(name, cfg)
          void webview.postMessage({ type: 'mcpSaved', seq: msg.seq, servers: mcp.list(), error: err || undefined })
        } catch (e) {
          void webview.postMessage({ type: 'mcpSaved', seq: msg.seq, servers: mcp.list(), error: (e as Error).message })
        }
        break
      }
      case 'mcpRemove': {
        const name = String(msg.name || '')
        try {
          await persistMcpServers(servers => { delete servers[name] })
          mcp.remove(name)
          void webview.postMessage({ type: 'mcpSaved', seq: msg.seq, servers: mcp.list() })
        } catch (e) {
          void webview.postMessage({ type: 'mcpSaved', seq: msg.seq, servers: mcp.list(), error: (e as Error).message })
        }
        break
      }
      case 'mcpReconnect': {
        const name = String(msg.name || '')
        const err = await mcp.reconnect(name)
        void webview.postMessage({ type: 'mcpSaved', seq: msg.seq, servers: mcp.list(), error: err || undefined })
        break
      }
    }
  }

  const provider = new ChatViewProvider(context.extensionUri, sinks, handleMessage)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codex-cn.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('codexCN.focus', () =>
      vscode.commands.executeCommand('workbench.view.extension.codex-cn')),
    vscode.commands.registerCommand('codex-cn.openChat', () =>
      vscode.commands.executeCommand('workbench.view.extension.codex-cn')),
    vscode.commands.registerCommand('codexCN.openSettings', () =>
      vscode.commands.executeCommand('codex-cn.openSettingsTab')),
    // 在编辑器区域以标签页打开 Agent（可多开/并排），与侧栏共享同一会话状态
    vscode.commands.registerCommand('codex-cn.openAgentTab', () => {
      const panel = vscode.window.createWebviewPanel(
        'codex-cn.agentTab',
        'Codex CN Agent',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] },
      )
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg')
      panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, 'agent')
      sinks.add(panel.webview)
      panel.onDidDispose(() => sinks.delete(panel.webview))
      panel.webview.onDidReceiveMessage((msg) => void handleMessage(panel.webview, msg))
    }),
    // 设置标签页：编辑器区打开，左导航右内容（只承载真实存在的设置分组）
    vscode.commands.registerCommand('codex-cn.openSettingsTab', () => {
      const panel = vscode.window.createWebviewPanel(
        'codex-cn.settingsTab',
        '设置',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri, context.globalStorageUri] },
      )
      panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, 'settings')
      sinks.add(panel.webview)
      panel.onDidDispose(() => sinks.delete(panel.webview))
      panel.webview.onDidReceiveMessage((msg) => void handleMessage(panel.webview, msg))
    })
  )
}

// ---- Webview View 提供器 ----
class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sinks: Set<vscode.Webview>,
    private readonly handleMessage: (webview: vscode.Webview, msg: any) => Promise<void>,
  ) { }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.sinks.add(view.webview)
    view.onDidDispose(() => this.sinks.delete(view.webview))
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] }
    view.webview.html = getWebviewHtml(view.webview, this.extensionUri, 'chat')
    view.webview.onDidReceiveMessage((msg) => void this.handleMessage(view.webview, msg))
  }
}

/** 视图类型：chat=侧栏聊天 agent=编辑器 Agent settings=设置标签页 */
type WebviewView = 'chat' | 'agent' | 'settings'

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: WebviewView): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'))
  const styles = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'))
  const nonce = getNonce()
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:;" />
<link rel="stylesheet" href="${styles}" />
</head>
<body>
  <div id="app" data-view="${view}"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
}

function getNonce(): string {
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length))
  return text
}

export { activate }
