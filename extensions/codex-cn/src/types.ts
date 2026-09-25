// 共享类型：OpenAI chat completion 结构（仅声明用到的部分）

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatCompletionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatResult {
  content: string
  toolCalls: ToolCall[]
  finishReason: string | null
  degraded: boolean
  error?: string
  aborted?: boolean
}
