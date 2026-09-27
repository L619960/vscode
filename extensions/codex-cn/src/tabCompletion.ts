// Tab 代码补全：InlineCompletionItemProvider + 提示词式 FIM（Fill-in-the-Middle）
// 防抖 300ms，新请求到来时中止上一个请求，网络错误静默返回空

import * as vscode from 'vscode'
import { getApiKey, getLLMConfig } from './config.js'

const DEBOUNCE_MS = 300
const PREFIX_LINES = 20
const SUFFIX_LINES = 10
const MAX_TOKENS = 128

export class TabCompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastRequestTime = 0
  private abortController: AbortController | null = null

  constructor(private readonly getApiKey: () => Promise<string>) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    // 开关：设置中可关闭 Tab 补全
    const enabled = vscode.workspace.getConfiguration('codex-cn').get<boolean>('tabCompletion', true)
    if (!enabled) return []

    // 防抖
    const now = Date.now()
    if (now - this.lastRequestTime < DEBOUNCE_MS) return []
    this.lastRequestTime = now

    // 取消上一个未完成的请求
    this.abortController?.abort()
    this.abortController = new AbortController()

    // 光标上下文：前 20 行 + 后 10 行
    const prefix = document.getText(new vscode.Range(
      new vscode.Position(Math.max(0, position.line - PREFIX_LINES), 0),
      position,
    ))
    const suffix = document.getText(new vscode.Range(
      position,
      new vscode.Position(Math.min(document.lineCount - 1, position.line + SUFFIX_LINES), 0),
    ))

    // 前缀为空或纯空白时不补全
    if (!prefix.trim()) return []

    const apiKey = await this.getApiKey()
    const config = getLLMConfig(apiKey)
    if (!config.baseUrl || !config.model) return []

    // Qwen3 系列默认思考模式会把小 max_tokens 全部耗在 <think> 里导致正文为空，需显式关闭
    const providerName = vscode.workspace.getConfiguration('codex-cn').get<string>('provider', 'doubao')

    try {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: 'system',
              content: `You are a code completion engine. Complete the code at <CURSOR>. Only output the completion text, no explanation, no markdown. Language: ${document.languageId}`,
            },
            {
              role: 'user',
              content: `<PREFIX>\n${prefix}\n<CURSOR>\n<SUFFIX>\n${suffix}`,
            },
          ],
          max_tokens: MAX_TOKENS,
          temperature: 0.2,
          stream: false,
          ...(providerName === 'llama' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        }),
        signal: this.abortController.signal,
      })

      if (!response.ok) return []
      const data = await response.json() as any
      const completion = data.choices?.[0]?.message?.content?.trim()
      if (!completion) return []

      // 清理 LLM 可能包裹的 markdown 代码块
      let clean = completion
      if (clean.startsWith('```')) {
        const lines = clean.split('\n')
        clean = lines.slice(1, lines.length > 1 && lines[lines.length - 1].startsWith('```') ? -1 : undefined).join('\n').trim()
      }

      if (!clean) return []

      return [new vscode.InlineCompletionItem(clean, new vscode.Range(position, position))]
    } catch (e) {
      // 网络错误 / 中止：静默返回空
      return []
    }
  }
}

export function registerTabCompletion(context: vscode.ExtensionContext): void {
  const provider = new TabCompletionProvider(() => getApiKey(context.secrets))
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
  )
}
