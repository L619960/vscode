// 内置浏览器：系统 Edge --headless=new + CDP（WebSocket 直连 page target）
// 提供 navigate/snapshot/click/type/scroll/screenshot/tabs/eval

import { spawn, type ChildProcess } from 'node:child_process'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
interface ElsInfo { ref: number; tag: string; type: string; label: string; cx: number; cy: number }
interface TargetInfo { id: string; title: string; url: string }

export class BrowserSession {
  private edge: ChildProcess | null = null
  private port = 0
  private profileDir = ''
  private pageWs: WebSocket | null = null
  private activeTargetId = ''
  private seq = 0
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private lastEls: ElsInfo[] = []

  private async ensureEdge(): Promise<void> {
    if (this.edge) return
    const edgePath = EDGE_CANDIDATES.find((p) => { try { return require('node:fs').existsSync(p) } catch { return false } })
    if (!edgePath) throw new Error('未找到系统 Microsoft Edge，浏览器工具不可用')
    this.port = await freePort()
    this.profileDir = join(tmpdir(), `codexcn-edge-${Date.now()}`)
    this.edge = spawn(edgePath, [
      '--headless=new', `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--window-size=1280,800', 'about:blank',
    ], { windowsHide: true })
    this.edge.on('exit', () => { this.edge = null; this.pageWs = null })
    // 等待 CDP 端点就绪
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      try { await this.http('/json/version'); return } catch { await sleep(300) }
    }
    throw new Error('Edge 启动超时（CDP 端口未就绪）')
  }

  private http(path: string, init?: RequestInit): Promise<any> {
    return fetch(`http://127.0.0.1:${this.port}${path}`, init).then((r) => r.json())
  }

  private async listPages(): Promise<TargetInfo[]> {
    const list = await this.http('/json/list')
    return list.filter((t: any) => t.type === 'page').map((t: any) => ({ id: t.id, title: t.title, url: t.url }))
  }

  /** 附加到指定（或首个）页面 target */
  private async attachPage(targetId?: string): Promise<void> {
    await this.ensureEdge()
    let pages = await this.listPages()
    let target = pages.find((p) => p.id === targetId)
    if (!target) {
      target = pages[0]
      if (!target) {
        // 无页面则新建（新版 CDP 需 PUT）
        await this.http('/json/new?about:blank', { method: 'PUT' }).catch(() => this.http('/json/new?about:blank'))
        pages = await this.listPages()
        target = pages[0]
      }
    }
    if (this.pageWs && this.activeTargetId === target.id) return
    this.detach()
    const list = await this.http('/json/list')
    const info = list.find((t: any) => t.id === target!.id)
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(info.webSocketDebuggerUrl)
      ws.onopen = (): void => {
        this.pageWs = ws
        this.activeTargetId = target!.id
        resolve()
      }
      ws.onerror = (): void => reject(new Error('无法连接浏览器 CDP'))
      ws.onmessage = (e): void => this.onMessage(e.data)
    })
    await this.cdp('Page.enable')
    await this.cdp('Runtime.enable')
  }

  private detach(): void {
    if (this.pageWs) { try { this.pageWs.close() } catch { /* ignore */ } }
    this.pageWs = null
    this.activeTargetId = ''
  }

  private onMessage(data: unknown): void {
    const msg = JSON.parse(String(data))
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  }

  private cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.pageWs) return Promise.reject(new Error('浏览器未连接'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.pageWs!.send(JSON.stringify({ id, method, params }))
    })
  }

  async navigate(rawUrl: string, newTab = false): Promise<{ ok: boolean; url?: string; title?: string; error?: string }> {
    let url = rawUrl.trim()
    if (!/^https?:\/\//i.test(url)) {
      if (/^[\w-]+(\.[\w-]+)+/.test(url)) url = 'http://' + url
      else return { ok: false, error: `URL 必须是 http(s) 地址: ${rawUrl}` }
    }
    try {
      if (newTab) {
        await this.ensureEdge()
        await this.http(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() =>
          this.http(`/json/new?${encodeURIComponent(url)}`))
        const pages = await this.listPages()
        await this.attachPage(pages[pages.length - 1].id)
      } else {
        await this.attachPage()
        await Promise.race([
          this.cdp('Page.navigate', { url }),
          sleep(12000),
        ])
        await sleep(800)
      }
      const info = await this.cdp('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,title:document.title})', returnByValue: true })
      return { ok: true, ...JSON.parse(info.result.value) }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }

  async snapshot(): Promise<{ ok: boolean; url?: string; title?: string; elements?: ElsInfo[]; text?: string; error?: string }> {
    try {
      await this.attachPage()
      const expr = `(function(){
        var ns=Array.prototype.slice.call(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"]'))
          .filter(function(e){return e.offsetParent!==null&&!e.disabled})
        var els=ns.map(function(e,i){var r=e.getBoundingClientRect()
          return {ref:i+1,tag:e.tagName.toLowerCase(),type:e.type||'',
            label:(e.innerText||e.textContent||e.value||e.getAttribute('aria-label')||'').trim().slice(0,60),
            cx:Math.round(r.x+r.width/2),cy:Math.round(r.y+r.height/2)}})
        return JSON.stringify({url:location.href,title:document.title,elements:els,text:document.body.innerText.slice(0,2000)})
      })()`
      const r = await this.cdp('Runtime.evaluate', { expression: expr, returnByValue: true })
      const out = JSON.parse(r.result.value)
      this.lastEls = out.elements
      return { ok: true, ...out }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }

  /** 真实鼠标点击（snapshot 元素坐标中心） */
  async click(ref: number): Promise<{ ok: boolean; url?: string; error?: string }> {
    const el = this.lastEls.find((x) => x.ref === ref)
    if (!el) return { ok: false, error: `ref ${ref} 已失效，请重新 browser_snapshot` }
    try {
      const mouse = (type: string): Promise<unknown> =>
        this.cdp('Input.dispatchMouseEvent', { type, x: el.cx, y: el.cy, button: 'left', clickCount: 1 })
      await mouse('mouseMoved'); await mouse('mousePressed'); await mouse('mouseReleased')
      await sleep(800)
      const u = await this.cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      return { ok: true, url: u.result.value }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }

  /** 聚焦元素后 Input.insertText（走真实输入路径，兼容 React/Vue 受控组件） */
  async type(ref: number, text: string, submit = false): Promise<{ ok: boolean; error?: string }> {
    const el = this.lastEls.find((x) => x.ref === ref)
    if (!el) return { ok: false, error: `ref ${ref} 已失效，请重新 browser_snapshot` }
    try {
      await this.cdp('Runtime.evaluate', { expression: `document.elementFromPoint(${el.cx},${el.cy})?.focus()` })
      // 清空已有值
      await this.cdp('Runtime.evaluate', { expression: `(function(){var e=document.elementFromPoint(${el.cx},${el.cy});if(e&&"value"in e){var d=Object.getOwnPropertyDescriptor(e.__proto__,"value");d&&d.set.call(e,"");e.dispatchEvent(new Event("input",{bubbles:true}))}})()` })
      await this.cdp('Input.insertText', { text })
      if (submit) {
        await this.cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await this.cdp('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', text: '\r' })
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await sleep(1000)
      }
      return { ok: true }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }

  async scroll(direction: 'up' | 'down', amount = 500): Promise<{ ok: boolean }> {
    const dy = direction === 'down' ? Math.abs(amount) : -Math.abs(amount)
    await this.cdp('Runtime.evaluate', { expression: `window.scrollBy(0,${dy})` })
    return { ok: true }
  }

  async screenshot(fullPage = false): Promise<{ ok: boolean; path?: string; error?: string }> {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return { ok: false, error: '未打开工作区' }
    try {
      const params: Record<string, unknown> = { format: 'png' }
      if (fullPage) {
        const size = await this.cdp('Runtime.evaluate', {
          expression: 'JSON.stringify([document.documentElement.scrollWidth,document.documentElement.scrollHeight])', returnByValue: true,
        })
        const [w, h] = JSON.parse(size.result.value)
        params.captureBeyondViewport = true
        params.clip = { x: 0, y: 0, width: Math.min(w, 1920), height: Math.min(h, 8000), scale: 1 }
      }
      const shot = await this.cdp('Page.captureScreenshot', params)
      const dirUri = vscode.Uri.joinPath(folder.uri, '.browser-shots')
      await vscode.workspace.fs.createDirectory(dirUri)
      const name = `shot_${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}.png`
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dirUri, name), Buffer.from(shot.data, 'base64'))
      return { ok: true, path: `.browser-shots/${name}` }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }

  async tabs(action: 'list' | 'activate' | 'close', index?: number): Promise<{ ok: boolean; tabs?: unknown[]; error?: string }> {
    try {
      await this.ensureEdge()
      const pages = await this.listPages()
      if (action === 'list') {
        return { ok: true, tabs: pages.map((p, i) => ({ index: i, title: p.title, url: p.url, active: p.id === this.activeTargetId })) }
      }
      const target = pages[index!]
      if (!target) return { ok: false, error: `标签序号 ${index} 不存在` }
      if (action === 'activate') await this.attachPage(target.id)
      if (action === 'close') {
        if (target.id === this.activeTargetId) this.detach()
        await this.http(`/json/close/${target.id}`).catch(() => undefined)
      }
      return { ok: true }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }

  async eval(script: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    try {
      await this.attachPage()
      const r = await this.cdp('Runtime.evaluate', {
        expression: `(function(){return (${script})})()`, returnByValue: true, awaitPromise: true,
      })
      if (r.exceptionDetails) return { ok: false, error: r.exceptionDetails.text }
      return { ok: true, value: r.result.value }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }

  dispose(): void {
    this.detach()
    if (this.edge) {
      try { spawn('taskkill', ['/pid', String(this.edge.pid), '/T', '/F'], { windowsHide: true }) } catch { /* ignore */ }
      this.edge = null
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)) })
    srv.on('error', reject)
  })
}
