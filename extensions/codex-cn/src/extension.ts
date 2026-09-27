// Codex CN 扩展入口：Webview View + Agent 桥 + 审批 / vscode.diff

import * as vscode from 'vscode'
import { Session } from './session.js'
import { runAgent, type AgentDeps } from './runAgent.js'
import { getApiKey, saveApiKey, getProvider, applyProviderPreset, setConfig, PROVIDER_PRESETS } from './config.js'
import { registerTabCompletion } from './tabCompletion.js'
import { registerInlineEdit } from './inlineEdit.js'
import { getCheckpoints, restoreCheckpoint, clearCheckpoints } from './checkpoints.js'
import { TaskBoard } from './taskBoard.js'
import { BackgroundShell } from './backgroundShell.js'
import { BrowserSession } from './browser.js'
import type { ApprovalDecision, ApprovalRequest } from './executor.js'

let session: Session
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

function activate(context: vscode.ExtensionContext): void {
  session = new Session(context.globalState)

  // 有状态工具依赖：任务规划板 / 后台 Shell / 内置浏览器
  const board = new TaskBoard(context.globalState)
  const bgShell = new BackgroundShell()
  const browser = new BrowserSession()
  context.subscriptions.push({ dispose: () => { bgShell.dispose(); browser.dispose() } })

  // 首次启动自动在右侧辅助栏打开 Agent 面板（Cursor 式默认布局），仅一次
  if (!context.globalState.get('codex-cn.autofocused')) {
    void context.globalState.update('codex-cn.autofocused', true)
    void vscode.commands.executeCommand('codex-cn.chat.focus')
  }

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

  // 审批桥：请求推给 webview，等待按钮回调；开启自动审批或会话免审批时直接放行
  // 但危险命令（rm/del/shutdown 等）始终询问，防止误操作
  const requestApproval = (req: ApprovalRequest): Promise<ApprovalDecision> => {
    if (req.danger) {
      // 危险命令不自动放行，必须人工确认
    } else {
      const auto = vscode.workspace.getConfiguration('codex-cn').get<boolean>('autoApprove', false)
      if (auto || autoApproved.has(req.toolName)) return Promise.resolve({ decision: 'allow' })
    }
    return new Promise<ApprovalDecision>((resolve) => {
      const id = `apr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      pending.set(id, resolve)
      postToWebview({ type: 'approval', id, ...req })
    })
  }

  // ---- Webview ----
  const provider = new ChatViewProvider(context.extensionUri, {
    getMessages: () => session.messages,
    getTodos: () => board.items,
    running: () => cancelSource !== null,
    async send(text: string) {
      if (cancelSource) return
      cancelSource = new vscode.CancellationTokenSource()
      postToWebview({ type: 'state', messages: session.messages, running: true, checkpoints: getCheckpoints().length, todos: board.items })
      const deps: AgentDeps = {
        session,
        getApiKey: () => getApiKey(context.secrets),
        requestApproval,
        onChange: () => postToWebview({ type: 'state', messages: session.messages, running: cancelSource !== null, checkpoints: getCheckpoints().length, todos: board.items }),
        toolDeps: { board, bgShell, browser },
      }
      await runAgent(text, deps, cancelSource.token)
      cancelSource = null
      postToWebview({ type: 'state', messages: session.messages, running: false, checkpoints: getCheckpoints().length, todos: board.items })
    },
    stop() {
      cancelSource?.cancel()
      cancelSource = null
      // 释放所有待审批 Promise（按拒绝处理）
      for (const [id, resolve] of pending) { resolve({ decision: 'deny', reason: '用户停止了任务' }); pending.delete(id) }
      postToWebview({ type: 'state', messages: session.messages, running: false, checkpoints: getCheckpoints().length, todos: board.items })
    },
    clear() {
      session.clear()
      clearCheckpoints()
      board.clear()
      postToWebview({ type: 'state', messages: session.messages, running: false, checkpoints: 0, todos: [] })
    },
    // 回滚：弹出快照列表（最新在前），选中后恢复对应文件
    async rollback() {
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
    },
    async getConfig() {
      const c = vscode.workspace.getConfiguration('codex-cn')
      const key = await getApiKey(context.secrets)
      return {
        provider: c.get('provider'), baseUrl: c.get('baseUrl'), model: c.get('model'),
        supportsTools: c.get('supportsTools'), autoApprove: c.get('autoApprove'), tabCompletion: c.get('tabCompletion'), hasKey: !!key,
        presets: Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([k, v]) => [k, v.label])),
        presetModels: Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([k, v]) => [k, v.model])),
      }
    },
    async saveConfig(patch: { provider?: string; baseUrl?: string; model?: string; supportsTools?: string; autoApprove?: boolean; tabCompletion?: boolean; apiKey?: string }) {
      if (patch.provider && patch.provider !== getProvider()) {
        await setConfig({ provider: patch.provider })
        await applyProviderPreset(patch.provider)
      }
      const rest: Partial<{ baseUrl: string; model: string; supportsTools: string; autoApprove: boolean; tabCompletion: boolean }> = {}
      if (patch.baseUrl !== undefined) rest.baseUrl = patch.baseUrl
      if (patch.model !== undefined) rest.model = patch.model
      if (patch.supportsTools !== undefined) rest.supportsTools = patch.supportsTools
      if (patch.autoApprove !== undefined) rest.autoApprove = patch.autoApprove
      if (patch.tabCompletion !== undefined) rest.tabCompletion = patch.tabCompletion
      if (Object.keys(rest).length) await setConfig(rest)
      if (patch.apiKey) await saveApiKey(context.secrets, patch.apiKey)
    },
    onDecision(d: { id: string; decision: 'allow' | 'deny' | 'always'; reason?: string; viewDiff?: boolean; req: ApprovalRequest }) {
      if (d.viewDiff) { openDiff(d.req); return }
      const resolve = pending.get(d.id)
      if (!resolve) return
      if (d.decision === 'always') { autoApproved.add(d.req.toolName) }
      resolve({ decision: d.decision === 'deny' ? 'deny' : 'allow', reason: d.reason })
      pending.delete(d.id)
    },
  })

  let postToWebview: (msg: unknown) => void = (msg) => provider.post(msg)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codex-cn.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('codexCN.focus', () =>
      vscode.commands.executeCommand('workbench.view.extension.codex-cn')),
    vscode.commands.registerCommand('codexCN.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.codex-cn')
      postToWebview({ type: 'openSettings' })
    })
  )
}

// ---- Webview View 提供器 ----
interface Bridge {
  getMessages(): unknown
  getTodos(): unknown
  running(): boolean
  send(text: string): Promise<void>
  stop(): void
  clear(): void
  rollback(): Promise<void>
  getConfig(): Promise<unknown>
  saveConfig(patch: unknown): Promise<void>
  onDecision(d: unknown): void
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: Bridge,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] }
    view.webview.html = this.getHtml(view.webview)
    view.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg.type) {
        case 'ready':
          view.webview.postMessage({ type: 'state', messages: this.bridge.getMessages(), running: this.bridge.running(), checkpoints: getCheckpoints().length, todos: this.bridge.getTodos() })
          break
        case 'send': await this.bridge.send(String(msg.text || '')); break
        case 'stop': this.bridge.stop(); break
        case 'clear': this.bridge.clear(); break
        case 'rollback': await this.bridge.rollback(); break
        case 'truncateMessages': {
          session.truncate(Number(msg.index))
          view.webview.postMessage({ type: 'state', messages: session.messages, running: cancelSource !== null, checkpoints: getCheckpoints().length, todos: this.bridge.getTodos() })
          break
        }
        case 'getConfig': view.webview.postMessage({ type: 'config', data: await this.bridge.getConfig() }); break
        case 'openSettings': void vscode.commands.executeCommand('codexCN.openSettings'); break
        case 'saveConfig': await this.bridge.saveConfig(msg.patch); view.webview.postMessage({ type: 'configSaved' }); break
        case 'setAgentMode': {
          const supportsTools = msg.mode === 'chat' ? 'no' : 'auto'
          await setConfig({ supportsTools })
          break
        }
        case 'decision': this.bridge.onDecision(msg); break
        case 'getWorkspaceFiles': {
          const folder = vscode.workspace.workspaceFolders?.[0]
          if (!folder) {
            view.webview.postMessage({ type: 'workspaceFiles', seq: msg.seq, files: [] })
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
          view.webview.postMessage({ type: 'workspaceFiles', seq: msg.seq, files: list })
          break
        }
      }
    })
  }

  post(msg: unknown): void { void this.view?.webview.postMessage(msg) }

  private getHtml(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'))
    const styles = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'))
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
  <div id="app"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }
}

function getNonce(): string {
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length))
  return text
}

export { activate }
