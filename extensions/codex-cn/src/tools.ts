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
      name: 'delete_file',
      description: '删除工作区内的文件或目录（需用户批准）。用于清理临时产物、移除废弃文件。删除前会保存快照供回滚。根目录与未打开工作区时禁止使用。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径（文件或目录）' },
          recursive: { type: 'boolean', description: '删除目录时是否递归，默认 false；目录非空且 recursive=false 会报错' },
        },
        required: ['path'],
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
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按 glob 模式快速查找文件名（如 "src/**/*.test.ts"、"**/*.md"）。支持 *、**、?。返回匹配的相对路径。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式' },
          path: { type: 'string', description: '限定搜索的子目录，默认整个工作区' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取指定 URL 的页面正文（自动转为纯文本），用于阅读官方文档、长文。单次最多返回约 6000 字符。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 http(s) URL' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_lints',
      description: '读取 VS Code 语言服务对文件的诊断（错误/警告，含行号与信息），相当于编辑器"问题"面板。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对文件或目录路径；省略则返回整个工作区的诊断' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'await_shell',
      description: '管理后台长驻进程（如 dev server）：start 启动并立即返回 id；logs 查看输出；wait 等待结束；stop 停止；list 列出。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'logs', 'wait', 'stop', 'list'], description: '操作类型' },
          command: { type: 'string', description: 'action=start 时要后台运行的命令（需批准）' },
          cwd: { type: 'string', description: 'action=start 时的工作子目录' },
          id: { type: 'string', description: 'logs/wait/stop 时的进程 id' },
          timeout: { type: 'integer', description: 'wait 最长等待毫秒，默认 30000' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: '设置（全量替换）本次任务的规划清单，用于主动登记调研/设计/开发/验证等检查点。每次传入完整列表。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '完整任务检查点列表',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: '检查点名称' },
                priority: { type: 'string', enum: ['P0', 'P1'], description: 'P0 阻断交付 / P1 次要' },
                status: { type: 'string', enum: ['done', 'running', 'error'], description: '完成/进行中/失败' },
                evidence: { type: 'string', description: '验证证据：日志/退出码/产物路径' },
                remark: { type: 'string', description: '边界说明、限制' },
              },
              required: ['label', 'priority', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '向用户发起结构化提问并暂停等待回答（不计入审批开关）。当任务存在必须由用户决定、且无法从代码或上下文推断的分叉（方案取舍、需求歧义、二选一）时调用；有合理默认值时不要滥用。用户停止任务时返回停止标记。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '问题本身，应包含必要的背景信息' },
          options: {
            type: 'array',
            description: '可选的候选答案（用户仍可自由输入）。每个选项一句话说明取舍',
            maxItems: 4,
            items: { type: 'string' },
          },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: '在内置浏览器中打开 URL（页面在后台加载），加载完成后可用 browser_snapshot 查看。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          new_tab: { type: 'boolean', description: '是否在新标签打开，默认 false' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: '获取当前页面快照：URL、标题、可交互元素（链接/按钮/输入框，带 ref 编号）、正文文本摘要。click/type 时使用返回的 ref。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '点击页面元素（ref 来自最近一次 browser_snapshot）。',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'integer', description: '元素编号' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '向输入框元素填入文本（先清空），ref 来自 browser_snapshot。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer' },
          text: { type: 'string' },
          submit: { type: 'boolean', description: '填完后按回车，默认 false' },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press_key',
      description: '向当前聚焦元素发送键盘按键（如回车提交、Esc 关闭弹窗、Tab 切焦点）。可传 ref 先聚焦该元素再按键。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '键名：Enter、Tab、Escape、Backspace、Delete、ArrowUp/Down/Left/Right、Home、End、PageUp、PageDown' },
          ref: { type: 'integer', description: '可选：先聚焦该元素（来自 browser_snapshot）' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description: '把输入框/文本域一次性整体填值（先清空再写入，兼容 React/Vue 受控组件），比 browser_type 快且稳定。ref 来自 browser_snapshot。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: '输入框元素编号' },
          value: { type: 'string', description: '要填入的完整值' },
        },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_select_option',
      description: '选择下拉框（select 元素）的选项，按 option 的 value 或显示文本匹配。ref 来自 browser_snapshot。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'select 元素编号' },
          value: { type: 'string', description: 'option 的 value 或显示文本' },
        },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: '滚动当前页面。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' },
          amount: { type: 'integer', description: '像素数，默认 500' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '对当前页面截图，保存为 PNG 到工作区 .browser-shots/ 目录，返回文件路径。',
      parameters: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: '是否整页截图，默认 false（仅可视区）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_tabs',
      description: '管理浏览器标签：list 列出 / activate 切换 / close 关闭。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'activate', 'close'] },
          index: { type: 'integer', description: 'activate/close 的标签序号（来自 list）' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_eval',
      description: '在当前页面执行 JavaScript 表达式并返回结果（沙箱页面内，无本机权限）。用于读取页面状态。',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript 表达式，如 document.title' },
        },
        required: ['script'],
      },
    },
  },
]

export const READ_TOOLS = new Set(['list_dir', 'read_file', 'search_files', 'web_search', 'glob', 'web_fetch', 'read_lints'])
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'run_command', 'await_shell'])
/** 浏览器工具（无需审批，在沙箱隐藏窗口内执行） */
export const BROWSER_TOOLS = new Set(['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_fill', 'browser_select_option', 'browser_scroll', 'browser_screenshot', 'browser_tabs', 'browser_eval'])
/** 规划类（AI 主动登记，无副作用） */
export const PLAN_TOOLS = new Set(['todo_write'])

export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  if (!args || typeof args !== 'object') return ''
  switch (name) {
    case 'list_dir': return String(args.path || '.')
    case 'read_file':
      return args.start_line ? `${args.path} :${args.start_line}-${args.end_line || ''}` : String(args.path || '')
    case 'write_file':
    case 'edit_file':
      return String(args.path || '')
    case 'delete_file': return String(args.path || '')
    case 'ask_user': return String(args.question || '')
    case 'run_command':
      return String(args.command || '')
    case 'search_files':
      return `"${args.query || ''}"${args.path ? ` in ${args.path}` : ''}`
    case 'web_search':
      return String(args.query || '')
    case 'glob': return String(args.pattern || '')
    case 'web_fetch': return String(args.url || '')
    case 'read_lints': return String(args.path || '.')
    case 'await_shell':
      return args.action === 'start' ? String(args.command || '') : `${args.action} ${args.id || ''}`
    case 'todo_write': return `${(args.items as unknown[] || []).length} 项检查点`
    case 'browser_navigate': return String(args.url || '')
    case 'browser_snapshot': return ''
    case 'browser_click': return `#${args.ref}`
    case 'browser_type': return `#${args.ref} 「${String(args.text || '').slice(0, 20)}」`
    case 'browser_press_key': return String(args.key || '')
    case 'browser_fill': return `#${args.ref} 「${String(args.value || '').slice(0, 20)}」`
    case 'browser_select_option': return `#${args.ref} → ${String(args.value || '').slice(0, 30)}`
    case 'browser_scroll': return String(args.direction || '')
    case 'browser_screenshot': return args.full_page ? '整页' : '可视区'
    case 'browser_tabs': return String(args.action || '')
    case 'browser_eval': return String(args.script || '').slice(0, 60)
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
    case 'delete_file': return `已删除 ${result.path}`
    case 'ask_user': return `用户回答：${String(result.answer || '').slice(0, 80)}`
    case 'run_command':
      return `退出码 ${result.code ?? 0}`
    case 'search_files':
      return `${(result.matches as unknown[])?.length ?? 0} 处匹配${result.truncated ? '（已截断）' : ''}`
    case 'web_search':
      return `${result.count ?? 0} 条结果`
    case 'glob': return `${(result.paths as unknown[])?.length ?? 0} 个文件`
    case 'web_fetch': return result.truncated ? `${(result.content as string).length} 字符（已截断）` : `${(result.content as string).length} 字符`
    case 'read_lints': return `${(result.diagnostics as unknown[])?.length ?? 0} 条诊断`
    case 'await_shell':
      if (result.action === 'start') return `已启动 ${result.id}（${result.running ? '运行中' : '已退出'}）`
      if (result.action === 'wait') return `进程已${result.exited ? '结束' : '超时仍在运行'}`
      if (result.action === 'stop') return '已停止'
      return '完成'
    case 'todo_write': return `已登记 ${result.total ?? 0} 项（P0 ${result.p0 ?? 0}，完成 ${result.done ?? 0}）`
    case 'browser_navigate': return `已打开 ${result.title || result.url}`
    case 'browser_snapshot': return `${(result.elements as unknown[])?.length ?? 0} 个可交互元素`
    case 'browser_click': return '已点击'
    case 'browser_type': return '已填入'
    case 'browser_press_key': return `已按键 ${result.key}`
    case 'browser_fill': return '已整体填值'
    case 'browser_select_option': return `已选中 ${result.selected ?? result.value}`
    case 'browser_scroll': return '已滚动'
    case 'browser_screenshot': return `截图 ${result.path}`
    case 'browser_tabs': return `${(result.tabs as unknown[])?.length ?? 0} 个标签`
    case 'browser_eval': return '已执行'
    default:
      return '完成'
  }
}
