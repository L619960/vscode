// Agent 工具协议：OpenAI function calling schema + 摘要格式化

import type { ChatCompletionTool } from './types.js'

export const TOOL_SCHEMAS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出工作区内某目录的文件和子目录，用于探索项目结构。已自动排除 node_modules 和隐藏文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，根目录用 "."' },
          depth: { type: 'integer', description: '递归深度 1-3，默认 1', minimum: 1, maximum: 3 },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容，返回带行号的文本。大文件用 start_line/end_line 分段读取，单次最多 500 行。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径' },
          start_line: { type: 'integer', description: '起始行（1 起），默认 1' },
          end_line: { type: 'integer', description: '结束行（含），默认到尾' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建新文件或整体覆盖已有文件（需用户批准）。对已有文件做局部修改时必须用 edit_file，不要重写整个文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '对已有文件做精确查找替换（需用户批准）。每个 edit 的 search 必须与文件内容逐字符一致（含缩进、换行）且在文件中唯一匹配，请带足够上下文。一次可传多个 edit，按顺序应用。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          edits: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                search: { type: 'string', description: '被替换的原文，须唯一匹配' },
                replace: { type: 'string', description: '替换后内容；删除代码时传空字符串' },
              },
              required: ['search', 'replace'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在工作区执行 Windows cmd 命令（需用户批准）。30 秒超时，输出截断。用于安装依赖、跑测试、构建等。禁止交互式命令。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'cmd 命令，如 "npm run build"' },
          cwd: { type: 'string', description: '相对工作区的子目录，默认根目录' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在工作区内按关键字或正则搜索文件内容，返回匹配的文件路径、行号、行内容（最多 60 条）。自动跳过 node_modules、二进制和大于 512KB 的文件。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键字或正则表达式' },
          is_regex: { type: 'boolean', description: '是否正则，默认 false' },
          path: { type: 'string', description: '限定子目录，默认整个工作区' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网获取信息。用于查找文档、API 用法、错误解决方案等。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
  },
]

export const READ_TOOLS = new Set(['list_dir', 'read_file', 'search_files', 'web_search'])
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_command'])

export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return ''
  switch (name) {
    case 'list_dir': return String(args.path || '.')
    case 'read_file':
      return args.start_line ? `${args.path} :${args.start_line}-${args.end_line || ''}` : String(args.path || '')
    case 'write_file':
    case 'edit_file':
      return String(args.path || '')
    case 'run_command':
      return String(args.command || '')
    case 'search_files':
      return `"${args.query || ''}"${args.path ? ` in ${args.path}` : ''}`
    case 'web_search':
      return String(args.query || '')
    default:
      return JSON.stringify(args).slice(0, 80)
  }
}

export function summarizeResult(name: string, result: Record<string, unknown>): string {
  if (!result || typeof result !== 'object') return ''
  if (result.ok === false) return String(result.error || '失败')
  switch (name) {
    case 'list_dir':
      return `${(result.entries as unknown[])?.length ?? 0} 个条目${result.truncated ? '（已截断）' : ''}`
    case 'read_file':
      return `读取了 ${result.total_lines ?? 0} 行${result.truncated ? '（已截断）' : ''}`
    case 'write_file':
      return `已写入 ${result.bytes ?? 0} 字节`
    case 'edit_file':
      return `应用了 ${result.edits_applied ?? 0} 处修改`
    case 'run_command':
      return `退出码 ${result.code ?? 0}`
    case 'search_files':
      return `${(result.matches as unknown[])?.length ?? 0} 处匹配${result.truncated ? '（已截断）' : ''}`
    case 'web_search':
      return `${result.count ?? 0} 条结果`
    default:
      return '完成'
  }
}
