// 后台 Shell 管理：await_shell 的进程池（spawn，输出环形缓冲）

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

interface BgProcess {
  id: string
  command: string
  child: ChildProcessWithoutNullStreams
  buffer: string
  exited: boolean
  code: number | null
}

const MAX_BUFFER = 16 * 1024
const MAX_LOGS_RETURN = 4000

export class BackgroundShell {
  private readonly procs = new Map<string, BgProcess>()
  private seq = 0

  start(command: string, cwdPath: string): BgInfo {
    const id = `bg_${Date.now().toString(36)}_${++this.seq}`
    // cmd /c 执行；chcp 65001 保证中文输出
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `chcp 65001 >nul && ${command}`], {
      cwd: cwdPath, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const bg: BgProcess = { id, command, child, buffer: '', exited: false, code: null }
    this.procs.set(id, bg)
    const append = (chunk: Buffer): void => {
      bg.buffer += chunk.toString('utf-8')
      if (bg.buffer.length > MAX_BUFFER) bg.buffer = bg.buffer.slice(-MAX_BUFFER)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('exit', (code) => { bg.exited = true; bg.code = code })
    child.on('error', (e) => { bg.exited = true; bg.buffer += `\n[启动失败: ${e.message}]` })
    return { action: 'start', id, running: true }
  }

  logs(id: string): { ok: boolean; logs?: string; running?: boolean; error?: string } {
    const bg = this.procs.get(id)
    if (!bg) return { ok: false, error: `找不到后台进程 ${id}` }
    const logs = bg.buffer.length > MAX_LOGS_RETURN ? bg.buffer.slice(-MAX_LOGS_RETURN) : bg.buffer
    return { ok: true, logs, running: !bg.exited }
  }

  /** 等待进程结束（或超时） */
  wait(id: string, timeoutMs: number): Promise<{ ok: boolean; exited: boolean; code?: number | null; logs?: string; error?: string }> {
    const bg = this.procs.get(id)
    if (!bg) return Promise.resolve({ ok: false, exited: true, error: `找不到后台进程 ${id}` })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ ok: true, exited: bg.exited, code: bg.code, logs: bg.buffer.slice(-MAX_LOGS_RETURN) })
      }, Math.min(timeoutMs, 60000))
      if (bg.exited) {
        clearTimeout(timer)
        resolve({ ok: true, exited: true, code: bg.code, logs: bg.buffer.slice(-MAX_LOGS_RETURN) })
        return
      }
      bg.child.once('exit', () => {
        clearTimeout(timer)
        resolve({ ok: true, exited: true, code: bg.code, logs: bg.buffer.slice(-MAX_LOGS_RETURN) })
      })
    })
  }

  stop(id: string): { ok: boolean; action?: string; error?: string } {
    const bg = this.procs.get(id)
    if (!bg) return { ok: false, error: `找不到后台进程 ${id}` }
    try { childKillTree(bg.child.pid) } catch { /* 已退出 */ }
    return { ok: true, action: 'stop' }
  }

  list(): Array<{ id: string; command: string; running: boolean }> {
    return [...this.procs.values()].map((bg) => ({ id: bg.id, command: bg.command, running: !bg.exited }))
  }

  /** 扩展停用时清理全部后台进程 */
  dispose(): void {
    for (const bg of this.procs.values()) {
      if (!bg.exited) { try { childKillTree(bg.child.pid) } catch { /* ignore */ } }
    }
    this.procs.clear()
  }
}

interface BgInfo {
  action: string
  id: string
  running: boolean
}

/** Windows 下杀进程树（/T 连同子进程，/F 强制），避免 dev server 派生进程残留 */
function childKillTree(pid?: number): void {
  if (!pid) return
  spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
}
