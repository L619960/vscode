// 行内编辑（Ctrl+K）：选中代码 + 自然语言指令 → LLM 改写 → 应用 / 放弃 / 查看 Diff

import * as vscode from 'vscode'
import { getApiKey, getLLMConfig } from './config.js'
import { chatCompletion } from './llm.js'
import type { ChatMessage } from './types.js'

/** codexcn-diff 内容供应器（结构由 extension.ts 注入，避免循环依赖） */
interface DiffContentStore {
  put(uri: vscode.Uri, content: string): void
}

/** 清理 LLM 可能包裹的 markdown 代码块，并去掉首尾空白行（保留首行缩进） */
function cleanLlmCode(text: string): string {
  let lines = text.split('\n')
  if (lines.length && lines[0].trimStart().startsWith('```')) lines = lines.slice(1)
  if (lines.length && lines[lines.length - 1].trimStart().startsWith('```')) lines = lines.slice(0, -1)
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines.join('\n')
}

async function runInlineEdit(context: vscode.ExtensionContext, diffStore: DiffContentStore): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    void vscode.window.showInformationMessage('Codex CN: 请先打开一个编辑器')
    return
  }
  const selection = editor.selection
  if (selection.isEmpty) {
    void vscode.window.showInformationMessage('Codex CN: 请先选中要修改的代码')
    return
  }

  const instruction = await vscode.window.showInputBox({
    prompt: '要做什么修改？',
    placeHolder: '例如：改成 async/await、加上错误处理、提取成函数…',
    ignoreFocusOut: true,
  })
  if (!instruction?.trim()) return

  const document = editor.document
  const selectedText = document.getText(selection)

  const apiKey = await getApiKey(context.secrets)
  const config = getLLMConfig(apiKey)
  if (!config.baseUrl || !config.model) {
    void vscode.window.showErrorMessage('Codex CN: 请先在设置中配置模型（Base URL / Model）')
    return
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a code editor. The user will give you code and an instruction. Return ONLY the modified code, no explanation, no markdown fences. Preserve the exact indentation and style.' },
    { role: 'user', content: `Language: ${document.languageId}\n\nCode:\n${selectedText}\n\nInstruction: ${instruction}` },
  ]

  const abort = new AbortController()
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Codex CN 正在修改代码…', cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => abort.abort())
      return chatCompletion({ messages, config, signal: abort.signal })
    },
  )

  if (result.aborted) return
  if (result.error) {
    void vscode.window.showErrorMessage(`Codex CN: ${result.error}`)
    return
  }

  const newText = cleanLlmCode(result.content)
  if (!newText.trim()) {
    void vscode.window.showWarningMessage('Codex CN: 模型未返回任何修改结果')
    return
  }
  if (newText === selectedText) {
    void vscode.window.showInformationMessage('Codex CN: 模型未做任何改动')
    return
  }

  const fileName = document.uri.path.split('/').pop() || 'file'

  // 用 codexcn-diff scheme 打开 原文 vs 改写 的对比视图
  const showDiff = async (): Promise<void> => {
    const left = vscode.Uri.parse(`codexcn-diff:///${fileName}?inline-old&t=${Date.now()}`)
    const right = vscode.Uri.parse(`codexcn-diff:///${fileName}?inline-new&t=${Date.now()}`)
    diffStore.put(left, selectedText)
    diffStore.put(right, newText)
    await vscode.commands.executeCommand('vscode.diff', left, right, `Codex CN 行内编辑: ${fileName}`)
  }

  // 决策循环：查看 Diff 后仍可回来选择应用 / 放弃
  for (;;) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '✓ 应用修改', action: 'apply' },
        { label: '✗ 放弃', action: 'reject' },
        { label: '📋 查看 Diff', action: 'diff' },
      ],
      { placeHolder: '如何处理 AI 的修改结果？' },
    )
    if (!pick || pick.action === 'reject') return
    if (pick.action === 'diff') {
      await showDiff()
      continue
    }
    await editor.edit(builder => builder.replace(selection, newText))
    return
  }
}

export function registerInlineEdit(context: vscode.ExtensionContext, diffStore: DiffContentStore): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codex-cn.inlineEdit', () => runInlineEdit(context, diffStore)),
  )
}
