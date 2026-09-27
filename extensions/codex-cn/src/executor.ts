// 工具执行器：vscode workspace.fs / 原生 ripgrep 式搜索（自走目录）/
// 写类走审批钩子 / run_command 用 child_process

import { exec as cpExec } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { READ_TOOLS, WRITE_TOOLS, BROWSER_TOOLS, PLAN_TOOLS, summarizeArgs } from './tools.js'
import { getAgentSettings } from './config.js'
import { saveCheckpoint } from './checkpoints.js'
import { webSearch } from './webSearch.js'
import type { TaskBoard, TaskCheckpoint } from './taskBoard.js'
import type { BackgroundShell } from './backgroundShell.js'
import type { BrowserSession } from './browser.js'
import type { ToolCall } from './types.js'

const execPromise = promisify(cpExec)
const DANGER_RE = /\b(rm\s+-rf|del\s+\/s|format|shutdown|rd\s+\/s|erase\s+\/s)\b/i
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.dll', '.zip', '.woff', '.woff2', '.ttf', '.pdf', '.mp3', '.mp4', '.webm'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.vscode', '.idea'])

// ---- Python 安装发现（PATH 可能缺失/编码损坏，导致 AI 的 python 命令全部失败）----
let cachedPython: string | null | undefined

/**
 * 优先用 py launcher（位于 System32，不受 PATH 损坏影响）查出真实 python.exe
 * 用 stdout.buffer 写死 UTF-8，避免管道默认编码（GBK/UTF-8）随环境变化
 */
function pythonViaPyLauncher(): string | null {
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
    const out = execFileSync('py', ['-c', 'import sys;sys.stdout.buffer.write(sys.executable.encode("utf-8"))'], {
      windowsHide: true, encoding: 'buffer', timeout: 8000,
      env: { ...process.env, PYTHONUTF8: '1' },
    }) as Buffer
    const py = new TextDecoder('utf-8').decode(out).trim()
    return existsSync(py) ? py : null
  } catch { return null }
}

/** 枚举所有用户目录下的 Python 安装（不依赖可能乱码的 LOCALAPPDATA） */
function pythonInUserProfiles(): string[] {
  const found: string[] = []
  let users: string[] = []
  try { users = readdirSync('C:\\Users') } catch { return found }
  for (const u of users) {
    const dir = join('C:\\Users', u, 'AppData', 'Local', 'Programs', 'Python')
    try {
      for (const d of readdirSync(dir)) {
        if (/^Python\d+/.test(d)) found.push(join(dir, d, 'python.exe'))
      }
    } catch { /* 无此目录 */ }
  }
  return found.filter(existsSync)
}

/** 发现本机 python.exe，按优先级返回；结果缓存 */
function findPythonInstall(): string | null {
  if (cachedPython !== undefined) return cachedPython
  const viaPy = pythonViaPyLauncher()
  if (viaPy) { cachedPython = viaPy; return viaPy }
  const candidates = pythonInUserProfiles()
  // 兜底：LOCALAPPDATA 与盘根
  const scan = (dir: string): void => {
    try {
      for (const d of readdirSync(dir)) {
        if (/^Python\d+/.test(d)) candidates.push(join(dir, d, 'python.exe'))
      }
    } catch { /* 目录不存在 */ }
  }
  if (process.env.LOCALAPPDATA) scan(join(process.env.LOCALAPPDATA, 'Programs', 'Python'))
  scan('C:\\')
  scan('D:\\')
  cachedPython = candidates.filter(existsSync).sort().reverse()[0] || null
  return cachedPython
}

/**
 * python 系命令在 PATH 缺失时，用发现的 python 重写命令：
 * python/python3 → 绝对路径；pip/pytest → python -m 形式
 */
function rewriteWithPython(command: string, py: string): string | null {
  let m: RegExpExecArray | null
  if ((m = /^python3?(?:\.exe)?(\s[\s\S]*)$/i.exec(command))) return `"${py}"${m[1]}`
  if ((m = /^pip3?(?:\.exe)?(\s[\s\S]*)$/i.exec(command))) return `"${py}" -m pip${m[1]}`
  if ((m = /^pytest(?:\.exe)?(\s[\s\S]*)$/i.exec(command))) return `"${py}" -m pytest${m[1]}`
  return null
}

export interface ApprovalRequest {
  toolName: string
  argsSummary: string
  command?: string
  danger?: boolean
  path?: string
  oldContent?: string
  newContent?: string
}
export interface ApprovalDecision {
  decision: 'allow' | 'deny'
  reason?: string
}

/** 执行钩子：await 时由扩展弹原生审批（含 Diff），同时驱动 webview 卡片状态 */
export interface ExecHooks {
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>
  setStatus(status: string): void
}

/** 扩展注入的有状态依赖（任务板 / 后台 Shell / 浏览器） */
export interface ToolDeps {
  board: TaskBoard
  bgShell: BackgroundShell
  browser: BrowserSession
}

// ---- 路径工具 ----
function normalizeRel(rel: string): string {
  const parts = String(rel).replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') { if (out.length > 0) out.pop(); continue }
    out.push(p)
  }
  return out.join('/')
}

function rootUri(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) throw new Error('未打开工作区')
  return folder.uri
}

function toUri(rel: string): vscode.Uri {
  const norm = normalizeRel(rel)
  if (norm.startsWith('..')) throw new Error('路径越出工作区')
  return vscode.Uri.joinPath(rootUri(), norm)
}

async function readText(uri: vscode.Uri): Promise<string> {
  const buf = await vscode.workspace.fs.readFile(uri)
  return new TextDecoder('utf-8').decode(buf)
}

function parseArgs(call: ToolCall): Record<string, any> {
  try { return call.function.arguments ? JSON.parse(call.function.arguments) : {} }
  catch { return {} }
}

// ---- 读类 ----
async function execRead(call: ToolCall): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  try {
    const ext = '.' + String(args.path).split('.').pop()?.toLowerCase()
    if (BINARY_EXT.has(ext)) return { ok: false, error: '二进制文件不支持读取' }
    const text = await readText(toUri(args.path))
    const lines = text.split('\n')
    const total = lines.length
    const start = Math.max(1, args.start_line || 1)
    const end = Math.min(total, args.end_line || total)
    const slice = lines.slice(start - 1, end)
    const maxLines = 500
    const truncated = slice.length > maxLines
    const outLines = truncated ? slice.slice(0, maxLines) : slice
    const content = outLines.map((l, i) => `${start + i}| ${l}`).join('\n')
    return { ok: true, path: normalizeRel(args.path), total_lines: total, content, start_line: start, truncated }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 目录递归（vscode.fs），depth 控制层级 */
async function walkDir(uri: vscode.Uri, depth: number): Promise<Array<{ name: string; type: string; depth: number }>> {
  const out: Array<{ name: string; type: string; depth: number }> = []
  if (depth < 1) return out
  let entries: [string, vscode.FileType][]
  try { entries = await vscode.workspace.fs.readDirectory(uri) } catch { return out }
  for (const [name, type] of entries) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const isDir = type === vscode.FileType.Directory
    out.push({ name, type: isDir ? 'directory' : 'file', depth })
    if (isDir) out.push(...await walkDir(vscode.Uri.joinPath(uri, name), depth - 1))
  }
  return out
}

async function execListDir(call: ToolCall): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  try {
    const baseRel = normalizeRel(args.path || '.')
    const baseUri = baseRel === '' ? rootUri() : toUri(baseRel)
    const maxDepth = Math.min(3, Math.max(1, args.depth ?? 1))
    const entries = await walkDir(baseUri, maxDepth)
    const max = 300
    return { ok: true, entries: entries.slice(0, max), truncated: entries.length > max }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 自走目录的内容搜索（跳过 node_modules/大文件/二进制） */
async function searchWalk(
  uri: vscode.Uri, query: string | RegExp, maxResults: number,
  matches: Array<{ path: string; line: number; text: string }>, relPrefix = '',
): Promise<void> {
  if (matches.length >= maxResults) return
  let entries: [string, vscode.FileType][]
  try { entries = await vscode.workspace.fs.readDirectory(uri) } catch { return }
  for (const [name, type] of entries) {
    if (matches.length >= maxResults) return
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const childUri = vscode.Uri.joinPath(uri, name)
    const rel = relPrefix ? `${relPrefix}/${name}` : name
    if (type === vscode.FileType.Directory) {
      await searchWalk(childUri, query, maxResults, matches, rel)
      continue
    }
    if (BINARY_EXT.has('.' + name.split('.').pop()?.toLowerCase())) continue
    try {
      const stat = await vscode.workspace.fs.stat(childUri)
      if (stat.size > 512 * 1024) continue
      const text = await readText(childUri)
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (query instanceof RegExp ? query.test(lines[i]) : lines[i].includes(query)) {
          matches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
          if (matches.length >= maxResults) return
        }
      }
    } catch { /* 跳过不可读文件 */ }
  }
}

async function execSearch(call: ToolCall): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  const queryStr = String(args.query || '')
  if (!queryStr) return { ok: false, error: 'query 不能为空' }
  try {
    const query = args.is_regex ? new RegExp(queryStr) : queryStr
    const baseRel = normalizeRel(args.path || '.')
    const baseUri = baseRel === '' ? rootUri() : toUri(baseRel)
    const matches: Array<{ path: string; line: number; text: string }> = []
    await searchWalk(baseUri, query, 60, matches)
    return { ok: true, matches, truncated: matches.length >= 60 }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** 联网搜索：无需审批，网络失败转为错误结果回喂给 AI */
async function execWebSearch(call: ToolCall): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  const query = String(args.query || '').trim()
  if (!query) return { ok: false, error: 'AI 调用 web_search 时未提供 query 参数' }
  try {
    const results = await webSearch(query)
    if (!results) return { ok: true, query, count: 0, results: '', note: '未找到相关结果，可换关键词重试' }
    return { ok: true, query, count: results.split('\n\n').length, results }
  } catch (e) {
    return { ok: false, error: `联网搜索失败: ${(e as Error).message}` }
  }
}

// ---- Glob：文件名模式匹配（findFiles）----
async function execGlob(call: ToolCall): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  const pattern = String(args.pattern || '').trim()
  if (!pattern) return { ok: false, error: 'glob 缺少 pattern 参数' }
  try {
    const baseRel = normalizeRel(args.path || '.')
    const baseUri = baseRel === '' ? rootUri() : toUri(baseRel)
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(baseUri, pattern), null, 300)
    const paths = uris.map((u) => vscode.workspace.asRelativePath(u)).slice(0, 200)
    return { ok: true, pattern, count: paths.length, paths }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---- WebFetch：抓取 URL 正文 ----
function htmlToText(html: string): string {
  let s = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<\/(div|p|li|h[1-6]|tr|table|section|article)>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

async function execWebFetch(call: ToolCall): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  const url = String(args.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'web_fetch 的 url 必须是 http(s) 地址' }
  try {
    const resp = await fetch(url, {
      redirect: 'follow', signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 CodexCN' },
    })
    const ctype = resp.headers.get('content-type') || ''
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
    let content: string
    if (/charset=([\w-]+)/i.test(ctype) && /gb|big5/i.test(RegExp.$1)) {
      content = new TextDecoder(RegExp.$1).decode(await resp.arrayBuffer())
    } else {
      content = await resp.text()
    }
    content = ctype.includes('html') ? htmlToText(content) : content
    const max = 6000
    const truncated = content.length > max
    return { ok: true, url, content: content.slice(0, max), truncated }
  } catch (e) {
    return { ok: false, error: `抓取失败: ${(e as Error).message}` }
  }
}

// ---- ReadLints：语言服务诊断 ----
const SEVERITY_LABEL = ['', 'error', 'warning', 'info', 'hint']

async function execReadLints(call: ToolCall): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  try {
    const target = args.path ? toUri(String(args.path)) : undefined
    const entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = target
      ? [[target, vscode.languages.getDiagnostics(target)]]
      : vscode.languages.getDiagnostics()
    const diagnostics = entries.flatMap(([uri, diags]) => diags.map((d) => ({
      path: vscode.workspace.asRelativePath(uri),
      line: d.range.start.line + 1, col: d.range.start.character + 1,
      severity: SEVERITY_LABEL[d.severity] || 'hint',
      message: d.message, source: d.source || '',
    }))).slice(0, 100)
    const errors = diagnostics.filter((d) => d.severity === 'error').length
    const warnings = diagnostics.filter((d) => d.severity === 'warning').length
    return { ok: true, count: diagnostics.length, errors, warnings, diagnostics }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---- 写类 ----
async function execWriteFile(call: ToolCall, hooks: ExecHooks): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  if (!args.path) return { ok: false, error: 'AI 调用 write_file 时未提供 path 参数，请重新描述任务' }
  const pathRel = normalizeRel(args.path)
  let oldContent = ''
  try { oldContent = await readText(toUri(pathRel)) } catch { /* 新文件 */ }
  hooks.setStatus('awaiting')
  const result = await hooks.requestApproval({
    toolName: 'write_file', argsSummary: summarizeArgs('write_file', args),
    path: pathRel, oldContent, newContent: String(args.content ?? ''),
  })
  if (result.decision !== 'allow') {
    return { ok: false, error: `用户拒绝了写入 ${pathRel}${result.reason ? '：' + result.reason : ''}` }
  }
  try {
    // 写入前保存快照，供「回滚」恢复
    await saveCheckpoint(toUri(pathRel).fsPath)
    const newContent = String(args.content ?? '')
    await vscode.workspace.fs.writeFile(toUri(pathRel), new TextEncoder().encode(newContent))
    return {
      ok: true, path: pathRel, bytes: new TextEncoder().encode(newContent).length,
      // 行数统计：供时间线「+N -M」变更卡片展示
      lines_added: newContent.split('\n').length,
      lines_removed: oldContent ? oldContent.split('\n').length : 0,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** search/replace：精确 indexOf，行尾空白宽松兜底，多处匹配拒绝 */
function applyEdits(content: string, edits: Array<{ search: string; replace: string }>):
  { ok: true; text: string; edits_applied: number } | { ok: false; error: string } {
  let text = content
  for (const ed of edits) {
    let idx = text.indexOf(ed.search)
    if (idx === -1) {
      const sNorm = ed.search.replace(/[ \t]+\n/g, '\n')
      const tNorm = text.replace(/[ \t]+\n/g, '\n')
      idx = tNorm.indexOf(sNorm)
      if (idx !== -1) {
        text = text.slice(0, idx) + ed.replace + text.slice(idx + ed.search.length)
        continue
      }
    }
    if (idx === -1) {
      const count = text.split(ed.search).length - 1
      if (count > 1) {
        return { ok: false, error: `search 在文件中出现 ${count} 处，无法唯一匹配。请缩小上下文或用 write_file 整体覆盖。` }
      }
      const preview = text.split('\n').slice(0, 30).join('\n')
      return { ok: false, error: `未找到匹配文本，请检查缩进/换行。以下为文件前 30 行供参考：\n${preview}` }
    }
    text = text.slice(0, idx) + ed.replace + text.slice(idx + ed.search.length)
  }
  return { ok: true, text, edits_applied: edits.length }
}

async function execEditFile(call: ToolCall, hooks: ExecHooks): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  if (!args.path) return { ok: false, error: 'AI 调用 edit_file 时未提供 path 参数，请重新描述任务' }
  const pathRel = normalizeRel(args.path)
  let content: string
  try { content = await readText(toUri(pathRel)) }
  catch (e) { return { ok: false, error: `读取文件失败: ${(e as Error).message}` } }

  const editRes = applyEdits(content, Array.isArray(args.edits) ? args.edits : [])
  if (!editRes.ok) return editRes

  hooks.setStatus('awaiting')
  const apr = await hooks.requestApproval({
    toolName: 'edit_file', argsSummary: summarizeArgs('edit_file', args),
    path: pathRel, oldContent: content, newContent: editRes.text,
  })
  if (apr.decision !== 'allow') {
    return { ok: false, error: `用户拒绝了编辑 ${pathRel}${apr.reason ? '：' + apr.reason : ''}` }
  }
  try {
    // 写入前保存快照，供「回滚」恢复
    await saveCheckpoint(toUri(pathRel).fsPath)
    await vscode.workspace.fs.writeFile(toUri(pathRel), new TextEncoder().encode(editRes.text))
    // 行数统计：供时间线「+N -M」变更卡片展示
    const edits = Array.isArray(args.edits) ? args.edits : []
    const linesAdded = edits.reduce((n: number, e: any) => n + String(e.replace ?? '').split('\n').length, 0)
    const linesRemoved = edits.reduce((n: number, e: any) => n + String(e.search ?? '').split('\n').length, 0)
    return { ok: true, path: pathRel, edits_applied: editRes.edits_applied, lines_added: linesAdded, lines_removed: linesRemoved }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function execRunCommand(call: ToolCall, hooks: ExecHooks): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  const command = String(args.command || '')
  if (!command) return { ok: false, error: 'AI 调用 run_command 时未提供 command 参数' }
  const danger = DANGER_RE.test(command)
  hooks.setStatus('awaiting')
  const apr = await hooks.requestApproval({
    toolName: 'run_command', argsSummary: summarizeArgs('run_command', args), command, danger,
  })
  if (apr.decision !== 'allow') {
    return { ok: false, error: `用户拒绝了运行命令${apr.reason ? '：' + apr.reason : ''}` }
  }
  const cwdRel = normalizeRel(args.cwd || '.')
  const cwdUri = cwdRel === '' ? rootUri() : toUri(cwdRel)
  const cwdPath = cwdUri.fsPath

  /** 单次执行：chcp 65001 保证中文输出编码；强制 Python 以 UTF-8 输出 */
  const runOnce = async (cmd: string): Promise<Record<string, any>> => {
    try {
      const { stdout: rawOut, stderr: rawErr } = await execPromise(`chcp 65001 >nul && ${cmd}`, {
        cwd: cwdPath, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      const max = 8192
      const stdout = String(rawOut || '').length > max ? String(rawOut).slice(0, max) + '\n[输出已截断]' : String(rawOut || '')
      const stderr = String(rawErr || '').length > max ? String(rawErr).slice(0, max) + '\n[输出已截断]' : String(rawErr || '')
      return { ok: true, code: 0, stdout, stderr }
    } catch (e: any) {
      if (e.killed && e.signal === 'SIGTERM') return { ok: false, error: '命令执行超过 30 秒已终止' }
      // exec 在非零退出码时 reject，stderr/stdout 在 e 上
      if (typeof e.code === 'number') {
        const stdout = String(e.stdout || '').slice(0, 8192)
        const stderr = String(e.stderr || '').slice(0, 8192)
        return { ok: false, code: e.code, stdout, stderr, error: stderr ? stderr.split('\n')[0] : '命令失败' }
      }
      return { ok: false, error: (e as Error).message }
    }
  }

  let result = await runOnce(command)

  // python 系命令失败：不靠错误文本判断（cmd 错误消息随系统语言/代码页变化，
  // 且可能是 GBK 乱码），直接发现本机 python 并用绝对路径重试一次。
  // 业务错误时重试结果等价，无害；命令已是绝对路径时无需重试。
  const isBarePythonCmd = /^python3?(?:\.exe)?\s|^pip3?(?:\.exe)?\s|^pytest(?:\.exe)?\s/i.test(command + ' ')
  if (!result.ok && isBarePythonCmd) {
    const py = findPythonInstall()
    if (py) {
      const rewritten = rewriteWithPython(command, py)
      if (rewritten && !rewritten.includes('""')) {
        result = await runOnce(rewritten)
        if (result.ok) result.note = `已自动使用本机 Python：${py}`
      }
    }
  }

  return result
}

// ---- AwaitShell：后台进程 ----
async function execAwaitShell(call: ToolCall, hooks: ExecHooks, deps: ToolDeps): Promise<Record<string, unknown>> {
  const args = parseArgs(call)
  const action = String(args.action || '')
  switch (action) {
    case 'start': {
      const command = String(args.command || '')
      if (!command) return { ok: false, error: 'await_shell start 缺少 command 参数' }
      const danger = DANGER_RE.test(command)
      hooks.setStatus('awaiting')
      const apr = await hooks.requestApproval({
        toolName: 'await_shell', argsSummary: summarizeArgs('await_shell', args), command, danger,
      })
      if (apr.decision !== 'allow') return { ok: false, error: `用户拒绝了后台命令${apr.reason ? '：' + apr.reason : ''}` }
      const cwdRel = normalizeRel(args.cwd || '.')
      const cwdUri = cwdRel === '' ? rootUri() : toUri(cwdRel)
      return { ok: true, ...deps.bgShell.start(command, cwdUri.fsPath) }
    }
    case 'logs': {
      if (!args.id) return { ok: false, error: 'logs 缺少 id' }
      return deps.bgShell.logs(String(args.id))
    }
    case 'wait': {
      if (!args.id) return { ok: false, error: 'wait 缺少 id' }
      const timeout = Math.min(Number(args.timeout) || 30000, 60000)
      return { action: 'wait', ...await deps.bgShell.wait(String(args.id), timeout) }
    }
    case 'stop': {
      if (!args.id) return { ok: false, error: 'stop 缺少 id' }
      return deps.bgShell.stop(String(args.id))
    }
    case 'list':
      return { ok: true, action: 'list', processes: deps.bgShell.list() }
    default:
      return { ok: false, error: `await_shell 未知 action: ${action}` }
  }
}

// ---- TodoWrite：AI 主动任务规划 ----
function normalizeCheckpoint(raw: unknown): TaskCheckpoint | null {
  const x = raw as Record<string, unknown>
  if (!x || typeof x.label !== 'string') return null
  const priority = x.priority === 'P1' ? 'P1' : 'P0'
  const status = x.status === 'running' || x.status === 'error' ? x.status : 'done'
  return {
    label: x.label.slice(0, 120), priority, status,
    evidence: typeof x.evidence === 'string' ? x.evidence.slice(0, 300) : undefined,
    remark: typeof x.remark === 'string' ? x.remark.slice(0, 300) : undefined,
  }
}

function execTodoWrite(call: ToolCall, deps: ToolDeps): Record<string, unknown> {
  const args = parseArgs(call)
  if (!Array.isArray(args.items)) return { ok: false, error: 'todo_write 缺少 items 数组' }
  const items = args.items.map(normalizeCheckpoint).filter((x): x is TaskCheckpoint => x !== null)
  if (!items.length) return { ok: false, error: 'items 中没有合法检查点（每项需有 label）' }
  return { ok: true, ...deps.board.replace(items) }
}

// ---- 浏览器工具分发 ----
async function execBrowser(call: ToolCall, deps: ToolDeps): Promise<Record<string, unknown>> {
  const name = call.function?.name
  const args = parseArgs(call)
  const b = deps.browser
  switch (name) {
    case 'browser_navigate': return b.navigate(String(args.url || ''), !!args.new_tab)
    case 'browser_snapshot': return b.snapshot()
    case 'browser_click': return b.click(Number(args.ref))
    case 'browser_type': return b.type(Number(args.ref), String(args.text || ''), !!args.submit)
    case 'browser_scroll': return b.scroll(String(args.direction) === 'up' ? 'up' : 'down', Number(args.amount) || 500)
    case 'browser_screenshot': return b.screenshot(!!args.full_page)
    case 'browser_tabs': {
      const action = String(args.action) as 'list' | 'activate' | 'close'
      const r = await b.tabs(action, Number(args.index))
      return r
    }
    case 'browser_eval': return b.eval(String(args.script || ''))
    default: return { ok: false, error: `未知浏览器工具: ${name}` }
  }
}

/** 联网工具名集合（工具开关与隐私模式共同作用于这些工具） */
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])
/** 纯文件读取类（不含联网） */
const FILE_READ_NAMES = new Set(['read_file', 'list_dir', 'search_files', 'glob', 'read_lints'])

/**
 * 工具策略闸门：实时读取设置，被禁用的工具不执行、直接返回错误结果。
 * 返回非空字符串 = 拦截原因；空串 = 放行。
 * 拦截结果会进入工具卡片并回喂 AI，形成真实闭环（不是仅 UI 禁用）。
 */
function blockedByPolicy(name: string | undefined, call: ToolCall): string {
  if (!name) return ''
  const s = getAgentSettings()

  // 隐私模式：独立于工具开关，优先拦截联网，防止代码片段随搜索外发
  if (s.privacyMode && WEB_TOOL_NAMES.has(name)) {
    return '隐私模式已开启，已阻止本次联网请求（防止代码片段随搜索外发）。可在「设置 → 隐私模式」中关闭后重试'
  }
  if (WEB_TOOL_NAMES.has(name) && !s.toolWeb) {
    return '联网工具（web_search / web_fetch）已在「设置 → 工具开关」中关闭，AI 无法联网'
  }
  if (FILE_READ_NAMES.has(name) && !s.toolRead) {
    return '文件读取类工具已在「设置 → 工具开关」中关闭，AI 无法读取项目文件'
  }
  if ((name === 'write_file' || name === 'edit_file') && !s.toolWrite) {
    return '文件写入类工具已在「设置 → 工具开关」中关闭，AI 无法修改任何文件'
  }
  if (name === 'run_command' && !s.toolShell) {
    return '命令执行工具已在「设置 → 工具开关」中关闭，AI 无法执行系统命令'
  }
  if (name === 'await_shell') {
    // start 受开关限制；logs/wait/stop/list 是管理操作，始终允许
    const action = String(parseArgs(call).action || '')
    if (action === 'start' && !s.toolShell) {
      return '命令执行工具已在「设置 → 工具开关」中关闭，AI 无法启动后台进程'
    }
  }
  if (BROWSER_TOOLS.has(name) && !s.toolBrowser) {
    return '浏览器工具已在「设置 → 工具开关」中关闭，AI 无法操作浏览器'
  }
  return ''
}

/** 执行单个 tool_call */
export async function executeToolCall(call: ToolCall, hooks: ExecHooks, deps: ToolDeps): Promise<Record<string, unknown>> {
  const name = call.function?.name

  // ★策略闸门：工具开关 / 隐私模式（在审批与执行之前拦截）
  const policyError = blockedByPolicy(name, call)
  if (policyError) return { ok: false, error: policyError }

  if (READ_TOOLS.has(name)) {
    switch (name) {
      case 'list_dir': return execListDir(call)
      case 'read_file': return execRead(call)
      case 'search_files': return execSearch(call)
      case 'web_search': return execWebSearch(call)
      case 'glob': return execGlob(call)
      case 'web_fetch': return execWebFetch(call)
      case 'read_lints': return execReadLints(call)
    }
  }
  if (WRITE_TOOLS.has(name)) {
    switch (name) {
      case 'write_file': return execWriteFile(call, hooks)
      case 'edit_file': return execEditFile(call, hooks)
      case 'run_command': return execRunCommand(call, hooks)
      case 'await_shell': return execAwaitShell(call, hooks, deps)
    }
  }
  if (PLAN_TOOLS.has(name)) return execTodoWrite(call, deps)
  if (BROWSER_TOOLS.has(name)) return execBrowser(call, deps)
  return { ok: false, error: `未知工具: ${name}` }
}
