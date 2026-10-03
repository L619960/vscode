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
 * 判断服务端错误是否为「工具调用参数过长被截断」：
 * llama.cpp 在生成长 JSON 中途撞 token 上限时，解析器报 missing closing quote /
 * unexpected end / invalid string，且错误位置（column）通常已在数千字符之后
 */
function isTruncationError(text: string): boolean {
  if (!/parse tool call|parse_error|tool call arguments/i.test(text)) return false
  if (/missing closing quote|unexpected end|unterminated|invalid string|end of input/i.test(text)) return true
  const col = /column\s+(\d+)/i.exec(text)
  return !!col && Number(col[1]) > 2000
}

/**
 * 判断服务端错误是否为「tool_calls JSON 解析失败」（llama.cpp grammar 阶段）。
 * 覆盖：parse tool call / invalid string / missing closing quote / unexpected token 等。
 */
function isToolCallParseError(text: string): boolean {
  return /parse tool call|invalid string|missing closing quote|unexpected end|unterminated string|expected .* in tool call|tool call.*parse/i.test(text)
}

/**
 * 构造降级到 XML 工具调用协议的消息列表。
 * 关键：llama.cpp chat template 只处理第一条 system 消息，所以把 XML 协议
 * 直接合并进第一条 system 的 content，而不是追加第二条 system（会被丢弃）。
 */
const XML_INSTRUCTION = [
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '【工具调用协议 · 强制】当前服务不支持原生 tool_calls，你必须用以下 XML 格式输出工具调用：',
  '格式：<tool_call name="工具名" args=\'{"key":"value"}\'>content</tool_call>',
  '规则：',
  '1. 每次回复只能包含一个 <tool_call>，不要输出其他任何文字',
  '2. args 用单引号包裹 JSON 对象（避免 JSON 内双引号冲突）',
  '3. write_file / edit_file 的 content 放在标签内部，可含任意换行和引号，无需转义',
  '4. 其他工具（run_command / read_file 等）content 留空',
  '示例1：<tool_call name="write_file" args=\'{"path":"main.py"}\'>print("hello")\nprint("world")</tool_call>',
  '示例2：<tool_call name="run_command" args=\'{"command":"dir"}\'></tool_call>',
  '示例3：<tool_call name="read_file" args=\'{"path":"main.py"}\'></tool_call>',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
].join('\n')

function buildXmlDegradedMessages(messages: ChatMessage[]): ChatMessage[] {
  const degraded = messages.map((m, idx) => {
    // 降级模式下剥离 tool_calls / tool_call_id，防止服务端 400
    const base: ChatMessage = { role: m.role, content: m.content }
    if (idx === 0 && m.role === 'system') {
      return { role: 'system' as const, content: (m.content || '') + XML_INSTRUCTION }
    }
    return base
  })
  if (degraded[0]?.role !== 'system') {
    degraded.unshift({ role: 'system', content: XML_INSTRUCTION })
  }
  return degraded
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
  const makeBody = (withTools: boolean, msgs: ChatMessage[] = messages): string => {
    // 无 tools 模式下剥离 tool_calls/tool_call_id，防止服务端 400
    const cleanMsgs = withTools ? msgs : msgs.map(m => ({ role: m.role, content: m.content }))
    return JSON.stringify({
      model: config.model,
      messages: cleanMsgs,
      stream: true,
      // 16384 上限：支持大文件生成（如完整 Vue 组件/长代码），避免 write_file 参数截断
      max_tokens: 16384,
      ...(withTools && tools?.length ? { tools, tool_choice: 'auto' } : {}),
    })
  }

  let withTools = config.supportsTools !== false && !!tools?.length
  // 若一开始就禁用 tools（持久化降级），直接在 system 注入 XML 协议，无需等 400/500
  const initialMessages = withTools ? messages : buildXmlDegradedMessages(messages)
  let resp: Response
  try {
    resp = await post(url, config.apiKey, makeBody(withTools, initialMessages), signal)
    // 兼容降级：部分服务收到 tools 直接 400 → 去掉 tools 并注入 XML 协议重试
    if (!resp.ok && withTools && resp.status === 400) {
      withTools = false
      onDegraded?.()
      const degradedMessages = buildXmlDegradedMessages(messages)
      resp = await post(url, config.apiKey, makeBody(false, degradedMessages), signal)
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { content: '', toolCalls: [], finishReason: null, degraded: false, aborted: true }
    return { content: '', toolCalls: [], finishReason: null, degraded: false, error: `网络错误: ${(e as Error).message}` }
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    // llama.cpp 服务端 500 重试一次（采样有随机性；本地模型生成长 JSON 时偶发格式错误）
    if (resp.status === 500 && isToolCallParseError(errText)) {
      await new Promise(r => setTimeout(r, 800))
      try {
        const retryResp = await post(url, config.apiKey, makeBody(withTools), signal)
        if (retryResp.ok) {
          resp = retryResp
        } else {
          const retryText = await retryResp.text().catch(() => '')
          // ★ 重试仍 parse tool call 失败：降级到无 tools 模式。
          // 弱模型把代码塞进 tool_calls JSON 时，llama.cpp grammar 解析必失败。
          // 降级后模型在 content 里用 XML 标签输出工具调用，由客户端解析。
          if (withTools && isToolCallParseError(retryText)) {
            onDegraded?.()
            const degradedMessages = buildXmlDegradedMessages(messages)
            const degResp = await post(url, config.apiKey, makeBody(false, degradedMessages), signal)
            if (degResp.ok) {
              resp = degResp
              withTools = false
            } else {
              const degText = await degResp.text().catch(() => '')
              const truncated = isTruncationError(errText) || isTruncationError(retryText)
              return {
                content: '', toolCalls: [], finishReason: null, degraded: true,
                error: `API 错误 ${degResp.status}: ${degText.slice(0, 300)}`,
                truncated,
              }
            }
          } else {
            const truncated = isTruncationError(errText) || isTruncationError(retryText)
            return {
              content: '', toolCalls: [], finishReason: null, degraded: false,
              error: `API 错误 ${retryResp.status}: ${retryText.slice(0, 300)}`,
              truncated,
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return { content: '', toolCalls: [], finishReason: null, degraded: false, aborted: true }
        return { content: '', toolCalls: [], finishReason: null, degraded: false, error: `网络错误: ${(e as Error).message}` }
      }
    } else {
      return {
        content: '', toolCalls: [], finishReason: null, degraded: false,
        error: `API 错误 ${resp.status}: ${errText.slice(0, 300)}`,
        truncated: resp.status === 500 && isTruncationError(errText),
      }
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
