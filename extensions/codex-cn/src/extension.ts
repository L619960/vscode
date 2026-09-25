// Codex CN 扩展入口：Webview View + Agent 桥 + 审批 / vscode.diff

import * as vscode from 'vscode'
import { Session } from './session.js'
import { runAgent, type AgentDeps } from './runAgent.js'
import { getApiKey, saveApiKey, getProvider, applyProviderPreset, setConfig, PROVIDER_PRESETS } from './config.js'
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

  // 首次启动自动在右侧辅助栏打开 Agent 面板（Cursor 式默认布局），仅一次
  if (!context.globalState.get('codex-cn.autofocused')) {
    void context.globalState.update('codex-cn.autofocused', true)
    void vscode.commands.executeCommand('codex-cn.chat.focus')
  }

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('codexcn-diff', diffProvider)
  )

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
    running: () => cancelSource !== null,
    async send(text: string) {
      if (cancelSource) return
      cancelSource = new vscode.CancellationTokenSource()
      postToWebview({ type: 'state', messages: session.messages, running: true })
      const deps: AgentDeps = {
        session,
        getApiKey: () => getApiKey(context.secrets),
        requestApproval,
        onChange: () => postToWebview({ type: 'state', messages: session.messages, running: cancelSource !== null }),
      }
      await runAgent(text, deps, cancelSource.token)
      cancelSource = null
      postToWebview({ type: 'state', messages: session.messages, running: false })
    },
    stop() {
      cancelSource?.cancel()
      cancelSource = null
      // 释放所有待审批 Promise（按拒绝处理）
      for (const [id, resolve] of pending) { resolve({ decision: 'deny', reason: '用户停止了任务' }); pending.delete(id) }
      postToWebview({ type: 'state', messages: session.messages, running: false })
    },
    clear() { session.clear(); postToWebview({ type: 'state', messages: session.messages, running: false }) },
    async getConfig() {
      const c = vscode.workspace.getConfiguration('codex-cn')
      const key = await getApiKey(context.secrets)
      return {
        provider: c.get('provider'), baseUrl: c.get('baseUrl'), model: c.get('model'),
        supportsTools: c.get('supportsTools'), autoApprove: c.get('autoApprove'), hasKey: !!key,
        presets: Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([k, v]) => [k, v.label])),
      }
    },
    async saveConfig(patch: { provider?: string; baseUrl?: string; model?: string; supportsTools?: string; autoApprove?: boolean; apiKey?: string }) {
      if (patch.provider && patch.provider !== getProvider()) {
        await setConfig({ provider: patch.provider })
        await applyProviderPreset(patch.provider)
      }
      const rest: Partial<{ baseUrl: string; model: string; supportsTools: string; autoApprove: boolean }> = {}
      if (patch.baseUrl !== undefined) rest.baseUrl = patch.baseUrl
      if (patch.model !== undefined) rest.model = patch.model
      if (patch.supportsTools !== undefined) rest.supportsTools = patch.supportsTools
      if (patch.autoApprove !== undefined) rest.autoApprove = patch.autoApprove
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
  running(): boolean
  send(text: string): Promise<void>
  stop(): void
  clear(): void
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
          view.webview.postMessage({ type: 'state', messages: this.bridge.getMessages(), running: this.bridge.running() })
          break
        case 'send': await this.bridge.send(String(msg.text || '')); break
        case 'stop': this.bridge.stop(); break
        case 'clear': this.bridge.clear(); break
        case 'getConfig': view.webview.postMessage({ type: 'config', data: await this.bridge.getConfig() }); break
        case 'saveConfig': await this.bridge.saveConfig(msg.patch); view.webview.postMessage({ type: 'configSaved' }); break
        case 'decision': this.bridge.onDecision(msg); break
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
