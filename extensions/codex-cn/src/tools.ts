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
      name: 'edit_notebook',
      description: '编辑 Jupyter 笔记本（.ipynb）的单元格。支持读取单元格列表、替换指定单元格内容、在指定位置插入新单元格、删除单元格。修改前会保存快照供回滚。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对路径，必须是 .ipynb 文件' },
          action: { type: 'string', enum: ['read', 'replace_cell', 'insert_cell', 'delete_cell'], description: '操作类型' },
          cell_index: { type: 'integer', description: '单元格索引（从 0 开始）。replace_cell/delete_cell 必传；insert_cell 表示在此位置前插入，省略则追加到末尾' },
          cell_type: { type: 'string', enum: ['code', 'markdown'], description: '单元格类型，insert_cell 时使用，默认 code' },
          source: { type: 'string', description: '单元格内容，replace_cell/insert_cell 时使用' },
        },
        required: ['path', 'action'],
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
      name: 'load_skill',
      description: '按需加载技能（领域知识/流程手册）的完整内容。系统提示中列出了可用技能索引（个人技能与 Superpowers 内置技能），任务命中某技能场景时调用一次即可，内容会进入本轮上下文。Superpowers 技能需要 references 附属文件时可用 file 参数再次加载。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '技能名（索引中列出的名称；个人技能 .md 后缀可省略，Superpowers 技能用英文目录名）' },
          file: { type: 'string', description: '可选：Superpowers 技能的附属文件相对路径（如 references/xxx.md），默认读取 SKILL.md' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_plan',
      description: '计划确认模式下提交实施方案。给出分步骤计划（做什么、改哪些文件、怎么验证），用户批准后才能执行写/命令类操作；用户提出修改意见时需修订后重新提交。',
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: '实施方案全文（分步骤，Markdown 格式）' },
        },
        required: ['plan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_user_memory',
      description: '把发现的跨会话用户偏好/习惯/约定追加到用户记忆文件（如：偏好的技术栈、沟通方式、工作流约定）。每条一行，只记录可复用的长期偏好，不记录任务细节。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要沉淀的用户偏好（一行，以 "- " 开头）' },
        },
        required: ['content'],
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
      name: 'spawn_task',
      description: '启动一个子 Agent 并行执行子任务（独立上下文，不共享当前会话）。用于可并行的大范围探索、专项审查、独立模块开发。子 Agent 有自己的工具调用能力，完成后结果自动回传。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '子任务描述（具体、可自测）' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: '子 Agent 可用的工具白名单（如 ["read_file","search_files"]）。默认继承全部工具，限制可防误操作。',
          },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'await_task',
      description: '等待指定子 Agent 完成并获取结果。spawn_task 返回后立即调用会阻塞等待；也可先做其他事再回来收取。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'spawn_task 返回的任务 id' },
          timeout: { type: 'integer', description: '最长等待毫秒，默认 120000' },
        },
        required: ['task_id'],
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
  {
    type: 'function',
    function: {
      name: 'browser_cdp',
      description: '直接执行 Chrome DevTools Protocol 命令（如 Network.enable、DOM.getDocument、Page.printToPDF 等）。当 browser_eval 无法满足需求（需要操作网络/渲染/DOM 树）时使用。返回 CDP 原始 result。',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'CDP 方法名，如 "Network.enable"、"Page.getCookies"' },
          params: { type: 'object', description: 'CDP 方法参数对象', additionalProperties: true },
        },
        required: ['method'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_mouse_click_xy',
      description: '按视口坐标点击（不依赖 snapshot 的 ref）。适用于 canvas 绘图、无标签元素、或 browser_click 无法定位的场景。坐标可先用 browser_get_bounding_box 获取。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: '视口 X 坐标（像素）' },
          y: { type: 'integer', description: '视口 Y 坐标（像素）' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_bounding_box',
      description: '获取 snapshot 元素的边界框（x/y/width/height，视口坐标）。用于为 browser_mouse_click_xy 或 browser_drag 提供精确坐标。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: '元素编号（来自 browser_snapshot）' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_drag',
      description: '拖拽：从起点坐标拖到终点坐标，分步移动模拟真实手势。坐标可通过 browser_get_bounding_box 获取。',
      parameters: {
        type: 'object',
        properties: {
          from_x: { type: 'integer', description: '起点 X 坐标' },
          from_y: { type: 'integer', description: '起点 Y 坐标' },
          to_x: { type: 'integer', description: '终点 X 坐标' },
          to_y: { type: 'integer', description: '终点 Y 坐标' },
          steps: { type: 'integer', description: '移动步数，默认 10', minimum: 1, maximum: 50 },
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_highlight',
      description: '用红色边框高亮 snapshot 元素（持续约 2 秒），用于调试时确认选中的元素是否正确。',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: '元素编号（来自 browser_snapshot）' },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_lock',
      description: '锁定当前浏览器标签，防止自动化操作期间焦点被其他操作抢占。锁定后除 browser_unlock 外的操作会被拒绝。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_unlock',
      description: '解锁浏览器标签，恢复正常操作。',
      parameters: { type: 'object', properties: {} },
    },
  },
]

export const READ_TOOLS = new Set(['list_dir', 'read_file', 'search_files', 'web_search', 'glob', 'web_fetch', 'read_lints'])
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'edit_notebook', 'run_command', 'await_shell'])
/** 浏览器工具（无需审批，在沙箱隐藏窗口内执行） */
export const BROWSER_TOOLS = new Set([
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_press_key', 'browser_fill', 'browser_select_option', 'browser_scroll',
  'browser_screenshot', 'browser_tabs', 'browser_eval',
  'browser_cdp', 'browser_mouse_click_xy', 'browser_get_bounding_box',
  'browser_drag', 'browser_highlight', 'browser_lock', 'browser_unlock',
])
/** 规划类（AI 主动登记，无副作用） */
export const PLAN_TOOLS = new Set(['todo_write'])
/** 子代理工具（spawn/await，由 runAgent 特殊处理） */
export const TASK_TOOLS = new Set(['spawn_task', 'await_task'])

// ---- 工具 schema 分组：浏览器工具体量大，默认不下发，任务涉及网页时才附带（省每轮 prefill token） ----
export const CORE_TOOL_SCHEMAS = TOOL_SCHEMAS.filter(t => !BROWSER_TOOLS.has(t.function.name))
export const BROWSER_TOOL_SCHEMAS = TOOL_SCHEMAS.filter(t => BROWSER_TOOLS.has(t.function.name))
/** 任务文本需要浏览器工具的判定：含 URL 或网页/浏览器相关关键词 */
export function wantsBrowser(text: string): boolean {
  return /https?:\/\//i.test(text) || /网页|浏览器|网站|网址|截图|抓取|爬虫|点击页面|browser/i.test(text)
}

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
    case 'edit_notebook': return `${args.action} ${args.path}${args.cell_index !== undefined ? `[${args.cell_index}]` : ''}`
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
    case 'load_skill': return String(args.name || '')
    case 'submit_plan': return String(args.plan || '').split('\n')[0].slice(0, 60)
    case 'save_user_memory': return String(args.content || '').slice(0, 50)
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
    case 'browser_cdp': return String(args.method || '')
    case 'browser_mouse_click_xy': return `(${args.x},${args.y})`
    case 'browser_get_bounding_box': return `#${args.ref}`
    case 'browser_drag': return `(${args.from_x},${args.from_y})→(${args.to_x},${args.to_y})`
    case 'browser_highlight': return `#${args.ref}`
    case 'browser_lock': return '锁定'
    case 'browser_unlock': return '解锁'
    case 'spawn_task': return String(args.task || '').slice(0, 60)
    case 'await_task': return String(args.task_id || '')
    default:
      return JSON.stringify(args).slice(0, 80)
  }
}

export function summarizeResult(name: string, result: Record<string, unknown>): string {
  if (!result || typeof result !== 'object') return ''
  if (result.ok === false) return String(result.error || '失败')
  // 缓存命中：返回提示而非"失败"
  if (result.cached === true) return String(result.hint || '内容未变更（已缓存）')
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
    case 'edit_notebook':
      if (result.action === 'read') return `${result.cell_count ?? 0} 个单元格`
      return `已${result.action === 'replace_cell' ? '替换' : result.action === 'insert_cell' ? '插入' : '删除'}单元格`
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
    case 'load_skill': return result.ok ? `已加载技能「${result.name}」` : `加载失败：${result.error || '未知'}`
    case 'submit_plan': return result.ok ? '方案已获用户批准' : `方案未通过：${result.error || result.feedback || '用户要求修改'}`
    case 'save_user_memory': return result.ok ? '已记录到用户记忆' : `记录失败：${result.error || '未知'}`
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
    case 'browser_cdp': return `CDP ${result.method || ''} 已执行`
    case 'browser_mouse_click_xy': return `已点击 (${result.x},${result.y})`
    case 'browser_get_bounding_box': return result.box ? `框: ${JSON.stringify(result.box)}` : '获取失败'
    case 'browser_drag': return '拖拽完成'
    case 'browser_highlight': return `已高亮 #${result.ref}`
    case 'browser_lock': return result.locked ? '已锁定' : '已解锁'
    case 'browser_unlock': return '已解锁'
    case 'spawn_task': return `子任务 ${result.task_id} 已启动`
    case 'await_task': return result.status === 'done' ? `子任务完成：${String(result.result || '').slice(0, 80)}` : `子任务${result.status === 'timeout' ? '超时' : '出错'}`
    default:
      return '完成'
  }
}
