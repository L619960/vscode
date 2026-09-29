/**
 * 容错 JSON 修复器
 *
 * 弱模型输出工具调用参数时，经常把大段代码（含未转义的双引号、换行）
 * 直接塞进 JSON 字符串，导致 JSON.parse 失败。
 *
 * 修复策略：状态机扫描原始字符串，识别字符串边界，对字符串内部的
 * 未转义双引号和控制字符做转义，使其成为合法 JSON。
 */

/**
 * 尝试修复一个不合法的 JSON 字符串，返回修复后的字符串。
 * 若无法修复，返回 null。
 */
export function repairJson(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null

  // 快速通道：本身就是合法 JSON
  try {
    JSON.parse(raw)
    return raw
  } catch {
    // 继续修复
  }

  const repaired = repairStringValues(raw)
  try {
    JSON.parse(repaired)
    return repaired
  } catch {
    return null
  }
}

/**
 * 核心修复：扫描字符串，对 JSON 字符串值内部的未转义引号和换行做转义。
 *
 * 状态机：
 * - inString: 当前是否在字符串内部
 * - 遇到 `\"` 是转义引号，跳过
 * - 在字符串内遇到 `"` 时，向后看：若后续紧跟 JSON 结构字符（, } ] : 或空白+结构字符），
 *   视为字符串结束；否则视为未转义的字面引号，转义为 `\"`
 * - 字符串内的换行符 \n \r \t 转义为 \\n \\r \\t
 */
function repairStringValues(raw: string): string {
  let out = ''
  let inString = false
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]

    if (!inString) {
      out += ch
      if (ch === '"') inString = true
      i++
      continue
    }

    // 在字符串内部
    if (ch === '\\') {
      // 转义序列：原样保留两个字符
      out += ch
      if (i + 1 < raw.length) {
        out += raw[i + 1]
        i += 2
      } else {
        i++
      }
      continue
    }

    if (ch === '"') {
      // 判断是字符串结束还是未转义的字面引号
      const isClosing = isStringClosingQuote(raw, i + 1)
      if (isClosing) {
        out += ch
        inString = false
        i++
      } else {
        // 未转义的字面引号，转义
        out += '\\"'
        i++
      }
      continue
    }

    if (ch === '\n') { out += '\\n'; i++; continue }
    if (ch === '\r') { out += '\\r'; i++; continue }
    if (ch === '\t') { out += '\\t'; i++; continue }

    out += ch
    i++
  }

  return out
}

/**
 * 判断位置 pos 处的 `"` 是否是字符串结束引号。
 * 逻辑：从 pos 开始跳过空白，若遇到 , } ] : 或字符串末尾，则是结束引号。
 */
function isStringClosingQuote(raw: string, pos: number): boolean {
  let j = pos
  while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t')) j++
  if (j >= raw.length) return true
  const c = raw[j]
  return c === ',' || c === '}' || c === ']' || c === ':'
}

/**
 * 从一段文本中提取首个 ``` 代码块内容（用于 write_file content 回退）。
 * 返回 { lang, content } 或 null。
 */
export function extractFirstCodeBlock(text: string): { lang: string; content: string } | null {
  if (!text) return null
  const m = text.match(/```(\w*)\n?([\s\S]*?)```/)
  if (!m) return null
  return { lang: m[1] || '', content: m[2].replace(/\n$/, '') }
}

/**
 * 从文本中提取所有 ``` 代码块，按出现顺序返回。
 */
export function extractAllCodeBlocks(text: string): Array<{ lang: string; content: string }> {
  if (!text) return []
  const blocks: Array<{ lang: string; content: string }> = []
  const re = /```(\w*)\n?([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    blocks.push({ lang: m[1] || '', content: m[2].replace(/\n$/, '') })
  }
  return blocks
}

/**
 * 从 assistant 文本中解析 <tool_call> XML 标签（降级模式用）。
 * 格式：<tool_call name="工具名" args='{"path":"x"}'>content</tool_call>
 * args 用单引号包裹 JSON（避免 JSON 内双引号冲突），content 在标签内可为任意文本。
 */
export interface XmlToolCall {
  name: string
  args: Record<string, unknown>
  content: string
}

export function parseXmlToolCalls(text: string): XmlToolCall[] {
  if (!text) return []
  const calls: XmlToolCall[] = []
  // 匹配 <tool_call ...>...</tool_call>，content 用非贪婪匹配
  const re = /<tool_call\s+([^>]*?)>([\s\S]*?)<\/tool_call>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1] || ''
    const content = m[2] || ''
    // 解析 name
    const nameMatch = attrs.match(/name\s*=\s*"([^"]*)"/)
    const name = nameMatch ? nameMatch[1] : ''
    // 解析 args：优先单引号包裹的 JSON，其次双引号
    let args: Record<string, unknown> = {}
    const argsSingle = attrs.match(/args\s*=\s*'([^']*)'/)
    const argsDouble = attrs.match(/args\s*=\s*"([^"]*)"/)
    const argsStr = argsSingle ? argsSingle[1] : argsDouble ? argsDouble[1] : ''
    if (argsStr) {
      try {
        args = JSON.parse(argsStr)
      } catch {
        const repaired = repairJson(argsStr)
        if (repaired) {
          try { args = JSON.parse(repaired) } catch { args = {} }
        }
      }
    }
    // write_file/edit_file 的 content 放在标签内
    if ((name === 'write_file' || name === 'edit_file') && !args.content && content.trim()) {
      args = { ...args, content }
    }
    calls.push({ name, args, content })
  }
  return calls
}

/**
 * 从 assistant 文本中解析 JSON 格式的工具调用（降级模式回退）。
 * 弱模型可能不遵循 XML，直接在 content 里输出 JSON：
 *   {"name":"write_file","arguments":{"path":"x","content":"..."}}
 * 或数组：[{"name":"run_command","arguments":{"command":"dir"}}]
 * 也兼容 function/parameters 字段名。
 */
export function parseJsonToolCalls(text: string): XmlToolCall[] {
  if (!text) return []
  const calls: XmlToolCall[] = []
  // 提取顶层 JSON 对象或数组（允许前后有空白/文字）
  const candidates = extractJsonObjects(text)
  for (const obj of candidates) {
    const name = obj.name || obj.function || ''
    const args = (obj.arguments || obj.parameters || obj.args || {}) as Record<string, unknown>
    if (!name || typeof name !== 'string') continue
    calls.push({ name, args, content: typeof args.content === 'string' ? args.content : '' })
  }
  return calls
}

/** 从文本中提取所有顶层 JSON 对象/数组（尝试 repairJson 修复） */
function extractJsonObjects(text: string): any[] {
  const results: any[] = []
  // 策略1：直接尝试把整段当 JSON（可能是数组或对象）
  const trimmed = text.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) results.push(...parsed)
      else results.push(parsed)
      return results
    } catch {
      const repaired = repairJson(trimmed)
      if (repaired) {
        try {
          const parsed = JSON.parse(repaired)
          if (Array.isArray(parsed)) results.push(...parsed)
          else results.push(parsed)
          return results
        } catch { /* 继续 */ }
      }
    }
  }
  // 策略2：逐个提取 {...} 块（简单平衡括号扫描）
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const snippet = text.slice(start, i + 1)
        try { results.push(JSON.parse(snippet)) }
        catch {
          const r = repairJson(snippet)
          if (r) { try { results.push(JSON.parse(r)) } catch { /* 跳过 */ } }
        }
        start = -1
      }
    }
  }
  return results
}
