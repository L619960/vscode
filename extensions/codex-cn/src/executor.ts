// 工具执行器：vscode workspace.fs / 原生 ripgrep 式搜索（自走目录）/
// 写类走审批钩子 / run_command 用 child_process

import { exec as cpExec } from 'node:child_process'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import { READ_TOOLS, WRITE_TOOLS, summarizeArgs } from './tools.js'
import type { ToolCall } from './types.js'

const execPromise = promisify(cpExec)
const DANGER_RE = /\b(rm\s+-rf|del\s+\/s|format|shutdown|rd\s+\/s|erase\s+\/s)\b/i
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.dll', '.zip', '.woff', '.woff2', '.ttf', '.pdf', '.mp3', '.mp4', '.webm'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.vscode', '.idea'])

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
    await vscode.workspace.fs.writeFile(toUri(pathRel), new TextEncoder().encode(String(args.content ?? '')))
    return { ok: true, path: pathRel, bytes: new TextEncoder().encode(String(args.content ?? '')).length }
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
    await vscode.workspace.fs.writeFile(toUri(pathRel), new TextEncoder().encode(editRes.text))
    return { ok: true, path: pathRel, edits_applied: editRes.edits_applied }
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
  try {
    const { stdout: rawOut, stderr: rawErr } = await execPromise(`chcp 65001 >nul && ${command}`, {
      cwd: cwdPath, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
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

/** 执行单个 tool_call */
export async function executeToolCall(call: ToolCall, hooks: ExecHooks): Promise<Record<string, unknown>> {
  const name = call.function?.name
  if (READ_TOOLS.has(name)) {
    switch (name) {
      case 'list_dir': return execListDir(call)
      case 'read_file': return execRead(call)
      case 'search_files': return execSearch(call)
    }
  }
  if (WRITE_TOOLS.has(name)) {
    switch (name) {
      case 'write_file': return execWriteFile(call, hooks)
      case 'edit_file': return execEditFile(call, hooks)
      case 'run_command': return execRunCommand(call, hooks)
    }
  }
  return { ok: false, error: `未知工具: ${name}` }
}
