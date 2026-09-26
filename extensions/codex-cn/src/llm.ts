// LLM 对接：OpenAI 兼容 /chat/completions，流式 tool_calls 按 index 累积，400 自动降级

import type { ChatCompletionTool, ChatMessage, ChatResult, ToolCall } from './types.js'

export interface LLMConfig {
  baseUrl: string
  apiKey: string
  model: string
  supportsTools: boolean | null // null=自动
}

async function post(url: string, apiKey: string, body: string, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    signal,
  })
}

/**
 * 流式对话补全
 * @param opts.messages OpenAI 消息数组
 * @param opts.tools 工具 schema
 * @param opts.signal 中止信号
 * @param opts.onToken content 增量回调
 * @param opts.onDegraded 触发降级时回调（用于 UI 提示）
 */
export async function chatCompletion(opts: {
  messages: ChatMessage[]
  tools?: ChatCompletionTool[]
  config: LLMConfig
  signal: AbortSignal
  onToken?: (token: string) => void
  onDegraded?: () => void
}): Promise<ChatResult> {
  const { messages, tools, config, signal, onToken, onDegraded } = opts

  // 本地服务（llama.cpp / Ollama 等）无需 API Key
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(config.baseUrl)
  if (!config.apiKey && !isLocal) {
    return { content: '', toolCalls: [], finishReason: null, degraded: false, error: '未配置 API Key，请先在设置中填写' }
  }

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`
  const makeBody = (withTools: boolean): string =>
    JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      max_tokens: 16384,
      ...(withTools && tools?.length ? { tools, tool_choice: 'auto' } : {}),
    })

  let withTools = config.supportsTools !== false && !!tools?.length
  let resp: Response
  try {
    resp = await post(url, config.apiKey, makeBody(withTools), signal)
    // 兼容降级：部分服务收到 tools 直接 400 → 去掉 tools 重试一次
    if (!resp.ok && withTools && resp.status === 400) {
      withTools = false
      onDegraded?.()
      resp = await post(url, config.apiKey, makeBody(false), signal)
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { content: '', toolCalls: [], finishReason: null, degraded: false, aborted: true }
    return { content: '', toolCalls: [], finishReason: null, degraded: false, error: `网络错误: ${(e as Error).message}` }
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    // llama.cpp 服务端 500 重试一次（本地模型生成长 JSON 时偶发格式错误）
    if (resp.status === 500 && errText.includes('parse tool call')) {
      await new Promise(r => setTimeout(r, 800))
      try {
        const retryResp = await post(url, config.apiKey, makeBody(withTools), signal)
        if (retryResp.ok) {
          resp = retryResp
        } else {
          const retryText = await retryResp.text().catch(() => '')
          return { content: '', toolCalls: [], finishReason: null, degraded: false, error: `API 错误 ${retryResp.status}: ${retryText.slice(0, 300)}` }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return { content: '', toolCalls: [], finishReason: null, degraded: false, aborted: true }
        return { content: '', toolCalls: [], finishReason: null, degraded: false, error: `网络错误: ${(e as Error).message}` }
      }
    } else {
      return { content: '', toolCalls: [], finishReason: null, degraded: false, error: `API 错误 ${resp.status}: ${errText.slice(0, 300)}` }
    }
  }
  const degraded = !withTools && !!tools?.length

  // ---- SSE 解析 ----
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason: string | null = null
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>()

  const eat = (json: any): void => {
    const choice = json.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta || {}
    if (delta.content) {
      content += delta.content
      onToken?.(delta.content)
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? 0
      const acc = toolAcc.get(i) || { id: '', name: '', arguments: '' }
      if (tc.id) acc.id += tc.id
      if (tc.function?.name) acc.name += tc.function.name
      const a = tc.function?.arguments
      if (typeof a === 'string') acc.arguments += a
      else if (a && typeof a === 'object') acc.arguments = JSON.stringify(a)
      toolAcc.set(i, acc)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') break
        try {
          eat(JSON.parse(data))
        } catch {
          /* 跳过坏行 */
        }
      }
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { content: '', toolCalls: [], finishReason: null, degraded: false, aborted: true }
    return { content: '', toolCalls: [], finishReason: null, degraded: false, error: `网络错误: ${(e as Error).message}` }
  }

  const toolCalls: ToolCall[] = [...toolAcc.values()].map((a, i) => ({
    id: a.id || `call_${Date.now()}_${i}`,
    type: 'function',
    function: { name: a.name, arguments: a.arguments || '{}' },
  }))

  return { content, toolCalls, finishReason, degraded }
}
