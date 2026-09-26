// 快照回滚：写文件/编辑文件前自动保存旧内容，支持通过 QuickPick 恢复

import * as vscode from 'vscode'

export interface Checkpoint {
  timestamp: number
  file: string
  content: string // 空字符串表示快照时文件不存在
}

const checkpoints: Checkpoint[] = []
/** 快照数量上限，超出丢弃最旧的 */
const MAX_CHECKPOINTS = 100

/** 保存文件当前内容快照（文件不存在时记录空内容，回滚即删除） */
export async function saveCheckpoint(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath)
  try {
    const buf = await vscode.workspace.fs.readFile(uri)
    checkpoints.push({ timestamp: Date.now(), file: filePath, content: new TextDecoder('utf-8').decode(buf) })
  } catch {
    // 文件可能尚不存在（新文件），记录空内容占位
    checkpoints.push({ timestamp: Date.now(), file: filePath, content: '' })
  }
  if (checkpoints.length > MAX_CHECKPOINTS) checkpoints.shift()
}

export function getCheckpoints(): Checkpoint[] {
  return [...checkpoints]
}

/** 恢复指定序号的快照；快照时文件不存在则删除该文件 */
export async function restoreCheckpoint(index: number): Promise<void> {
  const cp = checkpoints[index]
  if (!cp) return
  const uri = vscode.Uri.file(cp.file)
  if (cp.content === '') {
    await vscode.workspace.fs.delete(uri, { useTrash: false })
  } else {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(cp.content))
  }
}

export function clearCheckpoints(): void {
  checkpoints.length = 0
}
