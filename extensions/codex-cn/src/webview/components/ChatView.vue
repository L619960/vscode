<script setup lang="ts">
// 对话视图：消息流 + 工具卡片 + 阶段指示 + 输入区
import { ref, computed, onMounted, nextTick, watch, type Ref } from 'vue'
import { vscodeApi } from '../main'
import AgentSelectPop from './AgentSelectPop.vue'

interface ToolRun {
  id: string
  name: string
  argsSummary: string
  status: 'running' | 'awaiting' | 'done' | 'error' | 'rejected'
  resultSummary: string
  resultJson?: string   // 结构化结果（diff 行数统计等）
  argsJson?: string     // 原始工具参数（文件引用追踪等）
}
interface Msg {
  role: 'user' | 'assistant'
  content: string
  time: string
  ts?: number
  endTs?: number
  toolRuns?: ToolRun[]
}
/** 执行阶段：thinking（LLM 生成中）/ tool_call（执行工具）/ tool_result（回喂结果）/ responding（生成回复） */
type AgentPhase = 'thinking' | 'tool_call' | 'tool_result' | 'responding' | null

// ---- 工具分类（用于筛选）----
type ToolCategory = 'all' | 'file' | 'cmd' | 'mcp' | 'agent'
const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  read_file: 'file', write_file: 'file', edit_file: 'file', delete_file: 'file', list_dir: 'file', search_files: 'file', glob: 'file', read_lints: 'file',
  run_command: 'cmd', await_shell: 'cmd',
  spawn_task: 'agent', await_task: 'agent',
}

// ---- Cursor 风格时间线：按用户消息把会话切成回合 ----
interface ToolGroup {
  name: string
  label: string
  runs: ToolRun[]
  hasError: boolean
}
/** 时间线节点：按真实执行顺序排列 */
type TLNode =
  | { kind: 'think'; text: string }              // 回合首条文本（单行预览，点开看全文）
  | { kind: 'text'; text: string }               // 中间说明文本（全文显示）
  | { kind: 'group'; group: ToolGroup }          // 连续同名工具聚合组（明细直接可见）
  | { kind: 'pending'; run: ToolRun }            // 执行中/待审批（单独呈现）
/** 任务检查点（对接 AgentTaskCard 组件） */
interface TaskCheckpoint {
  label: string               // 检查点名称
  priority: 'P0' | 'P1'       // P0 阻断交付 / P1 次要
  status: 'done' | 'running' | 'error'
  evidence?: string           // 验证证据：退出码/产物路径/测试结果
  remark?: string             // 边界说明、限制
}
interface Segment {
  user?: Msg
  userIdx?: number            // 用户消息在 messages 中的下标（消息操作用）
  lastMsgIdx?: number         // 回合最后一条消息的下标（回退用）
  steps: Array<Msg & { idx: number }>   // 闲聊分支渲染用（idx 为原始消息下标，删除操作用）
  hasTools: boolean
  nodes: TLNode[]
  stepCount: number
  finalReply: string
  isLive: boolean
  elapsed: string
  taskItems: TaskCheckpoint[]  // 任务清单（写类工具）
  hasPendingReview: boolean    // 有文件待审查
  unrecoveredErrors: number    // 未被后续成功重试补偿的失败数
  retriedErrors: number        // 已被后续成功重试修复的失败数
}

const messages = ref<Msg[]>([])
const running = ref(false)
const paused = ref(false)
const stepping = ref(false)
const input = ref('')
// 可回滚的快照数量（>0 时显示回滚按钮）
const checkpoints = ref(0)
// AI 主动任务规划（todo_write）
const todos = ref<TaskCheckpoint[]>([])
const planClosed = ref(false)
// 当前执行阶段（ thinking / tool_call / tool_result / responding ）
const currentPhase = ref<AgentPhase>(null)
const phaseDetail = ref('')
const mcpStatus = ref('')
// 工具筛选
const toolFilter = ref<ToolCategory>('all')
const showToolFilter = ref(false)
/** 规划完成度统计 */
const planStats = computed(() => ({
  total: todos.value.length,
  p0: todos.value.filter((t) => t.priority === 'P0').length,
  done: todos.value.filter((t) => t.status === 'done').length,
  error: todos.value.filter((t) => t.status === 'error').length,
}))

const TOOL_LABELS: Record<string, string> = {
  list_dir: '列出目录', read_file: '读取文件', write_file: '写入文件',
  edit_file: '编辑文件', delete_file: '删除文件', run_command: '运行命令', search_files: '搜索文件',
  web_search: '联网搜索', glob: '匹配文件名', web_fetch: '抓取网页',
  read_lints: '读取诊断', await_shell: '后台进程', todo_write: '更新规划', ask_user: '向用户提问',
  load_skill: '加载技能', submit_plan: '提交方案', save_user_memory: '记录偏好',
  browser_navigate: '浏览器打开', browser_snapshot: '页面快照', browser_click: '浏览器点击',
  browser_type: '浏览器输入', browser_press_key: '按键操作', browser_fill: '整体填值', browser_select_option: '下拉选择',
  browser_scroll: '浏览器滚动', browser_screenshot: '页面截图',
  browser_tabs: '标签管理', browser_eval: '执行脚本',
}

/** 已完成工具的聚合文案（连续同名合并计数；写类统称「变更」） */
const GROUP_LABELS: Record<string, (n: number) => string> = {
  list_dir: (n) => `已列出 ${n} 个目录`,
  read_file: (n) => `已读取 ${n} 个文件`,
  write_file: (n) => `已变更 ${n} 项`,
  edit_file: (n) => `已变更 ${n} 项`,
  run_command: (n) => `已运行 ${n} 条命令`,
  search_files: (n) => `已搜索 ${n} 次文件`,
  web_search: (n) => `已联网搜索 ${n} 次`,
}
const GROUP_ICONS: Record<string, string> = {
  list_dir: '📂', read_file: '📄', write_file: '✏️', edit_file: '✏️',
  run_command: '⚡', search_files: '🔍', web_search: '🌐',
}

// 折叠状态：van-collapse v-model（存展开的 name）；思考/工具组默认收起（Trae 风格），记录展开的
const expandedTurns = ref<number[]>([])   // 外层 Agent 回合（执行中的回合默认展开，历史回合默认折叠）
const thinkActive = ref<string[]>([])     // 思考节点（默认折叠，name 为 回合:节点）
const groupOpen = ref<Set<string>>(new Set())  // 工具组（默认折叠，记录展开的 key）
const seenTurns = new Set<number>()
// 注意：模板里 ref 会自动解包，不能把 ref 当参数传递；Set 操作用专用函数
function flip<T>(setRef: Ref<Set<T>>, key: T): void {
  const next = new Set(setRef.value)
  if (next.has(key)) next.delete(key); else next.add(key)
  setRef.value = next
}
const toggleGroup = (key: string): void => flip(groupOpen, key)
function flipThink(key: string): void {
  const i = thinkActive.value.indexOf(key)
  if (i >= 0) thinkActive.value.splice(i, 1); else thinkActive.value.push(key)
}

// ---- 参考内容块：本地文件路径渲染为可点击链接，点击在编辑器打开 ----
type TextPart = { t: 'text' | 'path'; v: string }
// 绝对路径（盘符前不能紧跟字母数字，避免误匹配 http://）；相对路径须含分隔符或已知扩展名
const PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"()（），。；：、【】\[\]<>*?|]+|(?:[\w@.-]+[\\/])+[\w@.-]+\.[A-Za-z0-9]{1,10}\b|\b[\w@.-]+\.(?:ts|js|vue|py|md|json|html|css|txt|bat|ps1|sh|yml|yaml|toml|sql|java|cpp|c|h|go|rs)\b/g
function linkify(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(PATH_RE)) {
    let v = m[0]
    // 剥掉尾部标点（路径结尾常见的 . , 等）
    const trail = /[.,;!?，。；]+$/.exec(v)
    if (trail) v = v.slice(0, v.length - trail[0].length)
    if (!v) continue
    const start = m.index!
    if (start > last) parts.push({ t: 'text', v: text.slice(last, start) })
    parts.push({ t: 'path', v })
    last = start + v.length
  }
  if (last < text.length) parts.push({ t: 'text', v: text.slice(last) })
  return parts
}
function openFile(path: string): void {
  vscodeApi.postMessage({ type: 'openFile', path })
}

// 任务清单折叠状态（默认展开，name 为回合 index）
const taskListClosed = ref<Set<number>>(new Set())
const toggleTaskList = (i: number): void => flip(taskListClosed, i)
// 状态栏关闭记录（关闭后不再显示）
const statusBarDismissed = ref<Set<number>>(new Set())
const dismissStatusBar = (i: number): void => flip(statusBarDismissed, i)

/** 变更行数统计：从 resultJson 解析 +N -M */
function diffStat(t: ToolRun): { add: number; del: number } | null {
  if (t.status !== 'done' || !t.resultJson) return null
  try {
    const r = JSON.parse(t.resultJson)
    if (typeof r.lines_added !== 'number') return null
    return { add: r.lines_added, del: r.lines_removed || 0 }
  } catch { return null }
}

/** 把消息流切成回合：user 消息是边界；含工具的回合渲染为 Agent 时间线 */
const segments = computed<Segment[]>(() => {
  const raw: Array<{ user?: Msg; userIdx?: number; steps: Array<{ m: Msg; idx: number }> }> = []
  messages.value.forEach((m, idx) => {
    if (m.role === 'user') raw.push({ user: m, userIdx: idx, steps: [] })
    else {
      if (!raw.length) raw.push({ steps: [] })
      raw[raw.length - 1].steps.push({ m, idx })
    }
  })
  return raw.map((seg, i) => {
    const isLive = running.value && i === raw.length - 1
    const steps = seg.steps.map((s) => ({ ...s.m, idx: s.idx }))
    const hasTools = steps.some((s) => (s.toolRuns || []).length > 0)

    // 最终回复：回合已结束时，最后一条无工具的 assistant 正文
    const last = steps[steps.length - 1]
    const lastIsFinal = !isLive && !!last && !(last.toolRuns || []).length && !!last.content.trim()
    const finalReply = lastIsFinal ? last.content : ''
    const bodySteps = lastIsFinal ? steps.slice(0, -1) : steps

    // 按真实执行顺序生成节点：文本节点与工具组交错
    const nodes: TLNode[] = []
    let textSeen = 0
    for (const s of bodySteps) {
      const text = s.content.trim()
      if (text) nodes.push({ kind: textSeen++ === 0 ? 'think' : 'text', text })
      for (const t of s.toolRuns || []) {
        if (t.status === 'running' || t.status === 'awaiting') {
          nodes.push({ kind: 'pending', run: t })
          continue
        }
        const prev = nodes[nodes.length - 1]
        if (prev?.kind === 'group' && prev.group.name === t.name) prev.group.runs.push(t)
        else nodes.push({ kind: 'group', group: { name: t.name, label: '', runs: [t], hasError: false } })
      }
    }
    for (const n of nodes) {
      if (n.kind !== 'group') continue
      const g = n.group
      g.hasError = g.runs.some((r) => r.status === 'error' || r.status === 'rejected')
      g.label = (GROUP_LABELS[g.name] || ((x: number) => `${TOOL_LABELS[g.name] || g.name} ×${x}`))(g.runs.length)
    }

    // 耗时：从用户提问（或首条 assistant）到最后一条 assistant 的结束时间
    const start = seg.user?.ts ?? steps[0]?.ts ?? 0
    const end = isLive ? Date.now() : Math.max(0, ...steps.map((s) => s.endTs ?? s.ts ?? 0))
    const elapsed = start && end > start ? `${((end - start) / 1000).toFixed(1)}s` : ''

    // 任务清单：提取写类工具调用
    const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_command'])
    const taskItems: TaskCheckpoint[] = []
    for (const s of steps) {
      for (const t of s.toolRuns || []) {
        if (!WRITE_TOOLS.has(t.name)) continue
        const label = TOOL_LABELS[t.name] || t.name
        // 工具状态 → 检查点状态
        const status: TaskCheckpoint['status'] =
          t.status === 'done' ? 'done'
          : t.status === 'error' || t.status === 'rejected' ? 'error'
          : 'running'
        taskItems.push({
          label: `${label} ${t.argsSummary}`,
          // 写类操作都是核心交付动作，默认 P0
          priority: 'P0',
          status,
          // 验证证据：已完成/失败时取工具结果摘要（退出码/字节数/修改处数）
          evidence: status !== 'running' && t.resultSummary ? t.resultSummary : undefined,
        })
      }
    }
    const hasPendingReview = taskItems.some((t) => t.status === 'done' && (t.label.includes('写入') || t.label.includes('编辑')))

    // 失败补偿统计：error 项后面存在同工具（label 首词，如「运行命令」）的 done 项，视为已重试修复
    const toolOf = (label: string) => label.split(' ')[0]
    let unrecoveredErrors = 0
    let retriedErrors = 0
    taskItems.forEach((t, k) => {
      if (t.status !== 'error') return
      const fixed = taskItems.slice(k + 1).some((x) => x.status === 'done' && toolOf(x.label) === toolOf(t.label))
      if (fixed) retriedErrors++; else unrecoveredErrors++
    })

    const lastMsgIdx = seg.steps.length ? seg.steps[seg.steps.length - 1].idx : seg.userIdx
    return { user: seg.user, userIdx: seg.userIdx, lastMsgIdx, steps, hasTools, nodes, stepCount: nodes.length + (finalReply ? 1 : 0), finalReply, isLive, elapsed, taskItems, hasPendingReview, unrecoveredErrors, retriedErrors }
  })
})

/** 「AI 等待模型响应…」气泡：运行中且最后一段还没有任何可见节点时显示 */
const showWaiting = computed<boolean>(() => {
  if (!running.value) return false
  const last = segments.value[segments.value.length - 1]
  if (!last) return true
  return last.nodes.length === 0 && !last.finalReply
})

/** 阶段指示器文案 */
const phaseLabel = computed(() => {
  if (paused.value) return stepping.value ? '🐾 单步等待' : '⏸ 已暂停'
  if (!currentPhase.value) return ''
  const map: Record<string, string> = {
    thinking: '💭 思考中',
    tool_call: '🔧 执行工具',
    tool_result: '📥 结果回喂',
    responding: '💬 生成回复',
  }
  return map[currentPhase.value] || currentPhase.value
})

// ---- 文件引用追踪：从会话内 read/write/edit/delete 调用中提取去重 ----
interface FileRef { path: string; read: boolean; written: boolean }
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file'])
const fileRefs = computed<FileRef[]>(() => {
  const map = new Map<string, FileRef>()
  for (const msg of messages.value) {
    for (const t of msg.toolRuns ?? []) {
      if (t.name !== 'read_file' && !WRITE_TOOLS.has(t.name)) continue
      let p = ''
      try { p = String(JSON.parse(t.argsJson || '{}').path ?? '') } catch { continue }
      if (!p) continue
      const ref = map.get(p) ?? { path: p, read: false, written: false }
      if (t.name === 'read_file') ref.read = true
      if (WRITE_TOOLS.has(t.name)) ref.written = true
      map.set(p, ref)
    }
  }
  // 已修改的排前面，其次按路径排序
  return [...map.values()].sort((a, b) => Number(b.written) - Number(a.written) || a.path.localeCompare(b.path))
})
const fileRefsClosed = ref(false)
/** 只显示文件名，去掉目录前缀（hover 可见完整路径） */
function baseName(p: string): string { return p.split(/[\\/]/).pop() ?? p }

onMounted(() => {
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data
    if (m.type === 'state') {
      messages.value = m.messages
      running.value = m.running
      paused.value = m.paused ?? false
      stepping.value = m.stepping ?? false
      checkpoints.value = m.checkpoints ?? 0
      todos.value = m.todos || []
      if (m.sessions) sessions.value = m.sessions
      if (m.activeId !== undefined) activeId.value = m.activeId
      if (todos.value.length) planClosed.value = false
    } else if (m.type === 'phase') {
      currentPhase.value = m.phase as AgentPhase
      phaseDetail.value = m.detail || ''
      if (m.mcpStatus) mcpStatus.value = m.mcpStatus
    } else if (m.type === 'sessions') {
      sessions.value = m.sessions || []
      activeId.value = m.activeId
    } else if (m.type === 'workspaceFiles') {
      // 过期响应丢弃（seq 不同说明用户又输入了新字符）
      if (m.seq === fileSeq) fileItems.value = m.files || []
    } else if (m.type === 'config') {
      const d = m.data || {}
      modelPresets.value = d.presets || {}
      modelNames.value = d.presetModels || {}
      currentProvider.value = d.provider || ''
      currentModel.value = d.model || ''
    } else if (m.type === 'promptOptimized') {
      optimizing.value = false
      if (m.error) {
        toast.value = '优化失败：' + String(m.error).slice(0, 120)
      } else if (m.text) {
        input.value = String(m.text)
        void nextTick(() => textareaEl.value?.focus())
        toast.value = '提示词已优化'
      }
      setTimeout(() => { toast.value = '' }, 2500)
    } else if (m.type === 'skills') {
      // seq=0 是挂载时的技能缓存（供输入框「/」使用）；其他 seq 忽略
      if (m.seq === 0) skillCache.value = m.items || []
    } else if (m.type === 'skillsChanged') {
      // 设置页改动了技能：实时重新拉取缓存
      vscodeApi.postMessage({ type: 'listSkills', seq: 0 })
    }
  })
  vscodeApi.postMessage({ type: 'getConfig' })
  vscodeApi.postMessage({ type: 'listSkills', seq: 0 })
})

function send(): void {
  const text = input.value.trim()
  if (!text || running.value) return
  vscodeApi.postMessage({ type: 'send', text })
  input.value = ''
  references.value = []
  closeDropdown()
}
function stop(): void { vscodeApi.postMessage({ type: 'stop' }) }
function pause(): void { vscodeApi.postMessage({ type: 'pause' }) }
function resume(): void { vscodeApi.postMessage({ type: 'resume' }) }
function clearHistory(): void {
  if (confirm('确定清空当前会话？')) vscodeApi.postMessage({ type: 'clear' })
}
// 回滚：由扩展弹原生 QuickPick 选择快照并恢复
function rollback(): void { vscodeApi.postMessage({ type: 'rollback' }) }

// ---- 多会话：新建 / 历史 / 切换 / 删除 ----
interface SessionItem { id: string; title: string; createdAt: number; updatedAt: number }
const sessions = ref<SessionItem[]>([])
const activeId = ref('')
const showHistory = ref(false)
const confirmDeleteId = ref('')

function newSession(): void {
  // 正在运行的任务由扩展端先停止再新建（前端无需拦截）
  showHistory.value = false
  vscodeApi.postMessage({ type: 'newSession' })
}
function openHistoryItem(id: string): void {
  if (id === activeId.value) { showHistory.value = false; return }
  confirmDeleteId.value = ''
  vscodeApi.postMessage({ type: 'openSession', id })
  showHistory.value = false
}
function askDelete(id: string): void { confirmDeleteId.value = id }
function doDelete(id: string): void {
  vscodeApi.postMessage({ type: 'deleteSession', id })
  confirmDeleteId.value = ''
}
/** 相对时间：x分钟前 / x小时前 / 月-日（跨年加年份） */
function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return sameYear ? md : `${d.getFullYear()}年${md}`
}

// ---- 消息操作：复制 / 修改 / 回退 / 删除 ----
const copiedIdx = ref(-1)
/** 复制消息内容到剪贴板 */
async function copyMsg(content: string, idx: number): Promise<void> {
  try {
    await navigator.clipboard.writeText(content)
    copiedIdx.value = idx
    setTimeout(() => { copiedIdx.value = -1 }, 1200)
  } catch { /* webview 剪贴板不可用时静默 */ }
}
/** 修改：把该条用户消息内容装回输入框，并删除该条及之后的所有消息 */
function editMsg(seg: Segment): void {
  if (seg.userIdx === undefined) return
  input.value = seg.user?.content ?? ''
  void nextTick(() => textareaEl.value?.focus())
  vscodeApi.postMessage({ type: 'truncateMessages', index: seg.userIdx - 1 })
}
/** 回退：删除这条用户消息及其后的所有内容（重新来过的入口） */
function revertMsg(seg: Segment): void {
  if (seg.userIdx === undefined) return
  vscodeApi.postMessage({ type: 'truncateMessages', index: seg.userIdx - 1 })
}
/** 删除：从该消息（含）往后全部截断 */
function deleteMsg(idx: number): void {
  vscodeApi.postMessage({ type: 'truncateMessages', index: idx - 1 })
}

// ---- @ 文件/文件夹引用 + / 技能 ----
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const references = ref<string[]>([])
const dropdownOpen = ref(false)
/** 下拉内容类型：文件引用 or 技能 */
const dropdownKind = ref<'file' | 'skill'>('file')
const fileItems = ref<string[]>([])
/** 技能缓存（挂载时拉取；设置页改动后重新拉取） */
const skillCache = ref<Array<{ name: string; title: string; preview: string; content: string }>>([])
/** 技能下拉当前展示的条目（按输入过滤） */
const skillItems = ref<typeof skillCache.value>([])
const activeIndex = ref(0)
const mentionStart = ref(-1)
let fileSeq = 0
let fileTimer: number | undefined

/** 输入 / 点击：检测光标前是否处于 @引用 或 /技能 输入中 */
function onInput(): void {
  const el = textareaEl.value
  if (!el) return
  const pos = el.selectionStart
  const before = input.value.slice(0, pos)
  const atM = before.match(/(?:^|\s)@([^\s@]*)$/)
  const slashM = before.match(/(?:^|\s)\/([^\s/]*)$/)
  if (atM) {
    mentionStart.value = pos - atM[1].length - 1
    dropdownKind.value = 'file'
    dropdownOpen.value = true
    activeIndex.value = 0
    requestFiles(atM[1])
  } else if (slashM) {
    mentionStart.value = pos - slashM[1].length - 1
    dropdownKind.value = 'skill'
    const q = slashM[1].toLowerCase()
    skillItems.value = skillCache.value.filter(
      (s) => !q || s.title.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
    )
    dropdownOpen.value = true
    activeIndex.value = 0
  } else {
    closeDropdown()
  }
  syncReferences()
}

/** 下拉条目总数（键盘导航用） */
const dropdownCount = computed<number>(() =>
  dropdownKind.value === 'file' ? fileItems.value.length : skillItems.value.length,
)

/** 防抖请求工作区文件列表 */
function requestFiles(query: string): void {
  window.clearTimeout(fileTimer)
  fileTimer = window.setTimeout(() => {
    fileSeq++
    vscodeApi.postMessage({ type: 'getWorkspaceFiles', query, seq: fileSeq })
  }, 120)
}

function closeDropdown(): void {
  dropdownOpen.value = false
  fileItems.value = []
  skillItems.value = []
  mentionStart.value = -1
}

/** 选中候选：把 @query 替换为 @完整路径，并加入引用 chips */
function pickFile(path: string): void {
  const el = textareaEl.value
  if (!el || mentionStart.value < 0) return
  const before = input.value.slice(0, mentionStart.value)
  const after = input.value.slice(el.selectionStart)
  const token = `@${path} `
  input.value = before + token + after
  if (!references.value.includes(path)) references.value.push(path)
  closeDropdown()
  void nextTick(() => {
    el.focus()
    el.setSelectionRange(before.length + token.length, before.length + token.length)
  })
}

/** 选中技能：把 /query 替换为技能模板完整内容（真实文件内容） */
function pickSkill(item: { name: string; content: string }): void {
  const el = textareaEl.value
  if (!el || mentionStart.value < 0) return
  const before = input.value.slice(0, mentionStart.value)
  const after = input.value.slice(el.selectionStart)
  const body = item.content.trimEnd()
  // 保留前后各一个换行，让技能内容与后续补充文本分隔
  const token = (before && !before.endsWith('\n') ? '\n' : '') + body + '\n'
  input.value = before + token + after
  closeDropdown()
  void nextTick(() => {
    el.focus()
    const caret = before.length + token.length
    el.setSelectionRange(caret, caret)
  })
}

/** 移除 chip：同时删掉输入框中对应的 @token */
function removeReference(path: string): void {
  references.value = references.value.filter((r) => r !== path)
  const token = '@' + path
  const i = input.value.indexOf(token)
  if (i === -1) return
  let end = i + token.length
  if (input.value[end] === ' ') end++
  input.value = input.value.slice(0, i) + input.value.slice(end)
}

/** 输入被删改后，剔除文本中已不存在的引用 chip */
function syncReferences(): void {
  references.value = references.value.filter((r) => {
    const i = input.value.indexOf('@' + r)
    if (i === -1) return false
    const next = input.value[i + r.length + 1]
    return next === undefined || /\s/.test(next)
  })
}

/** 键盘：下拉打开时优先处理候选选择（上下移动 / 选中 / 关闭），否则 Enter 发送 */
function onKeydown(e: KeyboardEvent): void {
  // IME 组词中（中文输入法按 Enter 选字）不触发任何操作
  if (e.isComposing) return
  if (dropdownOpen.value) {
    if (e.key === 'Escape') { e.preventDefault(); closeDropdown(); return }
    const count = dropdownCount.value
    if (count) {
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex.value = (activeIndex.value + 1) % count; return }
      if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex.value = (activeIndex.value - 1 + count) % count; return }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (dropdownKind.value === 'file') pickFile(fileItems.value[activeIndex.value])
        else pickSkill(skillItems.value[activeIndex.value])
        return
      }
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault()
    if (running.value) stop(); else send()
  }
}

const statusText = computed(() => (running.value ? '停止' : '发送'))

// 自动滚动到底部
// ---- Agent 模式 + 模型选择 ----
const agentMode = ref<'chat' | 'agent'>('agent')
const composerFocused = ref(false)
const showModelPop = ref(false)
const toast = ref('')
const modelPresets = ref<Record<string, string>>({})
const modelNames = ref<Record<string, string>>({})
const currentProvider = ref('')
const currentModel = ref('')
function selectModel(key: string): void {
  currentProvider.value = key
  currentModel.value = modelNames.value[key] || ''
  showModelPop.value = false
  vscodeApi.postMessage({ type: 'saveConfig', patch: { provider: key } })
}
/** 模型按钮短名（参考图显示 Auto 风格）：取末段，超长省略 */
const modelShort = computed(() => {
  const m = currentModel.value
  if (!m) return 'Auto'
  const last = m.split(/[\\/]/).pop() || m
  return last.length > 14 ? last.slice(0, 12) + '…' : last
})

// ---- 提示词优化（✨）：调当前模型改写输入框内容并回填 ----
const optimizing = ref(false)
function optimizePrompt(): void {
  const text = input.value.trim()
  if (!text || optimizing.value || running.value) return
  optimizing.value = true
  vscodeApi.postMessage({ type: 'optimizePrompt', text })
}

const msgListEl = ref<HTMLElement | null>(null)
watch(messages, async () => {
  await nextTick()
  if (msgListEl.value) msgListEl.value.scrollTop = msgListEl.value.scrollHeight
}, { deep: true, flush: 'post' })

// 进行中的新回合默认展开；历史回合（恢复会话）默认折叠
watch(segments, (segs) => {
  if (!segs.length) { seenTurns.clear(); expandedTurns.value = [] }
  segs.forEach((s, i) => {
    if (s.hasTools && s.isLive && !seenTurns.has(i)) {
      seenTurns.add(i)
      expandedTurns.value.push(i)
    }
  })
})

// 任务完成：自动折叠该回合的步骤区（最终回复在折叠容器外，保持可见）
watch(running, (now, prev) => {
  if (!prev || now) return
  const lastIdx = segments.value.length - 1
  if (lastIdx >= 0 && segments.value[lastIdx].hasTools) {
    expandedTurns.value = expandedTurns.value.filter((i) => i !== lastIdx)
  }
})
</script>

<template>
  <div class="chat-view">
    <!-- 头部：品牌 + 新建会话 / 历史任务 -->
    <div class="chat-header">
      <span class="brand">Codex&nbsp;CN</span>
      <div class="header-tools">
        <button class="hdr-btn" title="新建会话" @click="newSession">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.4a8 8 0 0 1-.4-2.6A8.4 8.4 0 0 1 12.5 4.7 8.4 8.4 0 0 1 21 11.5z"/>
            <path d="M12 9v5M9.5 11.5h5"/>
          </svg>
        </button>
        <button class="hdr-btn" title="历史任务" @click="showHistory = true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3.3 7a9 9 0 1 1-1 8.5"/><path d="M3.3 3.5V7h3.5"/>
            <path d="M12 8v4.2l3 1.8"/>
          </svg>
        </button>
        <button class="hdr-btn" title="设置（在编辑器标签页打开）"
          @click="vscodeApi.postMessage({ type: 'openSettingsTab' })">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 阶段指示器 + MCP 状态灯 + 暂停/继续 -->
    <div v-if="running" class="phase-bar">
      <span class="phase-indicator">{{ phaseLabel }}<template v-if="phaseDetail"> · {{ phaseDetail }}</template></span>
      <button v-if="paused" class="mini phase-btn" @click="resume">{{ stepping ? '▶ 下一步' : '▶ 继续' }}</button>
      <button v-else class="mini phase-btn" @click="pause">⏸ 暂停</button>
      <button class="mini phase-btn stop" @click="stop">⏹ 终止</button>
      <span v-if="mcpStatus" class="mcp-status" title="MCP 工具服务器连接状态">{{ mcpStatus }}</span>
    </div>

    <div class="msg-list" ref="msgListEl">
      <!-- AI 任务规划（todo_write 驱动） -->
      <div v-if="todos.length" class="plan-card">
        <div class="plan-head" @click="planClosed = !planClosed">
          <span class="plan-title">📋 任务规划</span>
          <span class="plan-progress">{{ planStats.done }}/{{ planStats.total }} 完成<template v-if="planStats.error"> · {{ planStats.error }} 失败</template></span>
          <span class="plan-arrow">{{ planClosed ? '▸' : '▾' }}</span>
        </div>
        <div class="plan-list" v-show="!planClosed">
          <div v-for="(item, i) in todos" :key="i" class="plan-item" :class="item.status">
            <span class="task-prio" :class="item.priority">{{ item.priority }}</span>
            <span class="plan-icon">{{ item.status === 'done' ? '✅' : item.status === 'error' ? '❌' : '⏳' }}</span>
            <div class="task-body">
              <div class="plan-label">{{ item.label }}</div>
              <div v-if="item.evidence" class="task-evidence">证据：{{ item.evidence }}</div>
              <div v-if="item.remark" class="task-remark">备注：{{ item.remark }}</div>
            </div>
          </div>
        </div>
      </div>
      <!-- 本次会话涉及的文件：已修改排前，点击在编辑器中打开 -->
      <div v-if="fileRefs.length" class="fileref-card">
        <div class="plan-head" @click="fileRefsClosed = !fileRefsClosed">
          <span class="plan-title">📁 本次涉及文件</span>
          <span class="plan-progress">{{ fileRefs.filter(f => f.written).length }} 修改 / {{ fileRefs.length }} 总计</span>
          <span class="plan-arrow">{{ fileRefsClosed ? '▸' : '▾' }}</span>
        </div>
        <div class="fileref-list" v-show="!fileRefsClosed">
          <a v-for="f in fileRefs" :key="f.path" class="fileref-item" :class="{ written: f.written }"
            :title="f.path" @click.prevent="openFile(f.path)">
            <span class="fileref-icon">{{ f.written ? '✏️' : '📄' }}</span>
            <span class="fileref-name">{{ baseName(f.path) }}</span>
            <span v-if="f.written && f.read" class="fileref-tag">读+写</span>
          </a>
        </div>
      </div>
      <div v-if="messages.length === 0" class="empty">
        <p>👋 描述你的任务</p>
        <span>AI 会读项目、改文件、跑命令</span>
      </div>
      <template v-for="(seg, si) in segments" :key="si">
        <!-- 用户提问：紫色气泡 + 时间 + 操作（路径可点击打开） -->
        <div v-if="seg.user" class="msg user">
          <div class="bubble"><template v-for="(p, pi) in linkify(seg.user.content)" :key="pi"><a v-if="p.t === 'path'" class="flink" @click="openFile(p.v)">{{ p.v }}</a><span v-else>{{ p.v }}</span></template></div>
          <div class="msg-footer">
            <div class="msg-time">{{ seg.user.time }}</div>
            <div class="msg-actions">
              <button class="act-btn" :class="{ done: copiedIdx === si * 10 }" @click="copyMsg(seg.user.content, si * 10)">{{ copiedIdx === si * 10 ? '已复制' : '复制' }}</button>
              <button class="act-btn" @click="editMsg(seg)">修改</button>
              <button class="act-btn" @click="revertMsg(seg)">回退</button>
            </div>
          </div>
        </div>

        <!-- 纯闲聊：无工具调用，普通气泡 -->
        <template v-if="!seg.hasTools">
          <div v-for="(s, j) in seg.steps" :key="j" class="msg assistant">
            <div class="bubble"><template v-for="(p, pi) in linkify(s.content)" :key="pi"><a v-if="p.t === 'path'" class="flink" @click="openFile(p.v)">{{ p.v }}</a><span v-else>{{ p.v }}</span></template></div>
            <div class="msg-footer">
              <div class="msg-actions">
                <button class="act-btn" :class="{ done: copiedIdx === si * 10 + j + 1 }" @click="copyMsg(s.content, si * 10 + j + 1)">{{ copiedIdx === si * 10 + j + 1 ? '已复制' : '复制' }}</button>
                <button class="act-btn" @click="deleteMsg(s.idx)">删除</button>
              </div>
            </div>
          </div>
        </template>

        <!-- Agent 回合：Vant4 van-collapse 折叠时间线 -->
        <van-collapse v-else v-model="expandedTurns" :border="false">
          <van-collapse-item :name="si">
            <!-- 自定义头部：Agent 标题栏 -->
            <template #title>
              <div class="agent-header">
                <span class="agent-dot"></span>
                <span class="agent-title">Agent</span>
                <span class="agent-meta">{{ seg.stepCount }} 步{{ seg.elapsed ? ` · ${seg.isLive ? '进行中' : '耗时'} ${seg.elapsed}` : '' }}</span>
              </div>
            </template>

            <!-- 折叠内部内容：任务清单面板 + 步骤区 -->
            <div class="agent-body">
              <!-- 任务清单：写类工具摘要（可折叠） -->
              <div v-if="seg.taskItems.length" class="task-card-wrap">
                <div class="task-list" v-show="!taskListClosed.has(si)">
                  <div v-for="(item, idx) in seg.taskItems" :key="idx" class="task-item" :class="item.status">
                    <span class="task-icon">{{ item.status === 'done' ? '✅' : item.status === 'error' ? '❌' : '⏳' }}</span>
                    <div class="task-body">
                      <div class="task-line">
                        <span class="task-prio" :class="item.priority">{{ item.priority }}</span>
                        <span class="task-text">{{ item.label }}</span>
                      </div>
                      <div v-if="item.evidence" class="task-evidence">证据：{{ item.evidence }}</div>
                      <div v-if="item.remark" class="task-remark">备注：{{ item.remark }}</div>
                    </div>
                  </div>
                </div>
                <!-- 底部状态栏 -->
                <div v-if="!statusBarDismissed.has(si)" class="task-status-bar">
                  <div class="status-left">
                    <button class="btn-toggle" @click="toggleTaskList(si)">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#ccc"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
                    </button>
                    <button class="btn-file" title="查看变更文件">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#ccc"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>
                    </button>
                  </div>
                  <div class="status-main">
                    <span class="task-icon running" v-if="seg.isLive">⏳</span>
                    <span class="task-icon failed" v-else-if="seg.unrecoveredErrors > 0">❌</span>
                    <span class="task-icon done" v-else>✅</span>
                    <span class="status-text">{{
                      seg.isLive ? '任务执行中…'
                      : seg.unrecoveredErrors > 0 ? `部分任务失败（${seg.unrecoveredErrors} 项未恢复）`
                      : seg.retriedErrors > 0 ? `任务已完成（${seg.retriedErrors} 项失败已重试修复），文件需要审查`
                      : seg.hasPendingReview ? '任务已完成，文件需要审查'
                      : '任务已完成'
                    }}</span>
                  </div>
                  <div class="status-close" @click="dismissStatusBar(si)">×</div>
                </div>
              </div>

              <!-- 步骤区（思考、文本、工具、pending） -->
              <div class="agent-steps">
                <template v-for="(node, ni) in seg.nodes" :key="ni">
                <!-- 思考：Trae 风格折叠块，左图标右箭头，默认收起，点击平滑展开 -->
                <div v-if="node.kind === 'think'" class="step">
                  <div class="step-rail"><span class="step-ico">💡</span></div>
                  <div class="step-main">
                    <div class="tl-head" @click="flipThink(si + ':' + ni)">
                      <span class="tl-title">思考</span>
                      <span v-if="!thinkActive.includes(si + ':' + ni)" class="think-preview">{{ node.text }}</span>
                      <span class="tl-chev" :class="{ open: thinkActive.includes(si + ':' + ni) }">▸</span>
                    </div>
                    <div class="tl-collapse" :class="{ open: thinkActive.includes(si + ':' + ni) }">
                      <div class="tl-collapse-inner">
                        <div class="think-body"><template v-for="(p, pi) in linkify(node.text)" :key="pi"><a v-if="p.t === 'path'" class="flink" @click="openFile(p.v)">{{ p.v }}</a><span v-else>{{ p.v }}</span></template></div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 中间说明文本：全文显示（路径可点击） -->
                <div v-else-if="node.kind === 'text'" class="step">
                  <div class="step-rail"><span class="step-ico">📄</span></div>
                  <div class="step-main">
                    <div class="step-text"><template v-for="(p, pi) in linkify(node.text)" :key="pi"><a v-if="p.t === 'path'" class="flink" @click="openFile(p.v)">{{ p.v }}</a><span v-else>{{ p.v }}</span></template></div>
                  </div>
                </div>

                <!-- 工具聚合组：Trae 风格折叠块，默认收起只显示标题，点击平滑展开明细 -->
                <div v-else-if="node.kind === 'group'" class="step">
                  <div class="step-rail"><span class="step-ico">{{ GROUP_ICONS[node.group.name] || '🔧' }}</span></div>
                  <div class="step-main">
                    <div class="tl-head" :class="{ error: node.group.hasError }" @click="toggleGroup(si + ':' + ni)">
                      <span class="tl-title">{{ node.group.label }}</span>
                      <span class="tl-chev" :class="{ open: groupOpen.has(si + ':' + ni) }">▸</span>
                    </div>
                    <div class="tl-collapse" :class="{ open: groupOpen.has(si + ':' + ni) }">
                      <div class="tl-collapse-inner">
                        <div class="group-detail">
                          <!-- 变更卡片：写/编辑类工具带 +N -M 统计 -->
                          <div v-for="t in node.group.runs" :key="t.id" class="gd-row" :class="t.status">
                            <span class="gd-name">{{ TOOL_LABELS[t.name] || t.name }}</span>
                            <span class="gd-args"><template v-for="(p, pi) in linkify(t.argsSummary)" :key="pi"><a v-if="p.t === 'path'" class="flink" @click.stop="openFile(p.v)">{{ p.v }}</a><span v-else>{{ p.v }}</span></template></span>
                            <template v-if="diffStat(t)">
                              <span class="gd-diff-add">+{{ diffStat(t)!.add }}</span>
                              <span class="gd-diff-del">-{{ diffStat(t)!.del }}</span>
                            </template>
                            <span class="gd-badge" :class="t.status">{{
                              t.status === 'done' ? '完成' : t.status === 'rejected' ? '已拒绝' : '失败'
                            }}</span>
                            <div v-if="t.status !== 'done' && t.resultSummary" class="gd-result">{{ t.resultSummary }}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- 执行中（不聚合，实时呈现） -->
                <div v-else class="step">
                  <div class="step-rail"><span class="step-ico pending">{{ GROUP_ICONS[node.run.name] || '🔧' }}</span></div>
                  <div class="step-main">
                    <div class="step-title" :class="node.run.status">
                      {{ TOOL_LABELS[node.run.name] || node.run.name }} {{ node.run.argsSummary }}
                      <span class="gd-badge" :class="node.run.status">执行中</span>
                    </div>
                    <div v-if="node.run.resultSummary" class="gd-result">{{ node.run.resultSummary }}</div>
                  </div>
                </div>
              </template>
              </div>
            </div>
          </van-collapse-item>

          <!-- ✅ 最终回复：放在 van-collapse-item 外面，永远可见！（路径可点击） -->
          <div v-if="seg.finalReply" class="step reply-step final-reply">
            <div class="step-rail"><span class="step-ico end"></span></div>
            <div class="step-main">
              <div class="reply-body"><template v-for="(p, pi) in linkify(seg.finalReply)" :key="pi"><a v-if="p.t === 'path'" class="flink" @click="openFile(p.v)">{{ p.v }}</a><span v-else>{{ p.v }}</span></template></div>
            </div>
          </div>
        </van-collapse>
      </template>

      <!-- 等待模型响应 -->
      <div v-if="showWaiting" class="msg assistant">
        <div class="bubble waiting">AI 等待模型响应…</div>
      </div>
    </div>

    <!-- 清空 / 回滚（容器外的辅助操作） -->
    <div v-if="messages.length" class="composer-extra">
      <button class="link" @click="clearHistory">清空对话</button>
      <button v-if="checkpoints > 0" class="link no-push" @click="rollback">回滚({{ checkpoints }})</button>
    </div>

    <div class="composer" :class="{ focused: composerFocused }">
      <!-- @ 引用 chips -->
      <div v-if="references.length" class="ref-chips">
        <span v-for="r in references" :key="r" class="ref-chip">
          {{ r.endsWith('/') ? '📁' : '📄' }} {{ r }}
          <button class="ref-x" title="移除引用" @click="removeReference(r)">×</button>
        </span>
      </div>

      <!-- 输入区：占位大文本 + 右上角闪光图标 -->
      <div class="composer-input">
        <textarea
          ref="textareaEl"
          v-model="input"
          rows="2"
          :placeholder="running ? 'AI 正在工作…' : '帮你编写代码、调试 Bug、优化性能等开发工作…'"
          @focusin="composerFocused = true"
          @focusout="composerFocused = false"
          @input="onInput"
          @click="onInput"
          @keydown="onKeydown"
        ></textarea>
        <button
          class="sparkle" :class="{ loading: optimizing }"
          :title="optimizing ? '正在优化提示词…' : '优化提示词（AI 改写输入内容）'"
          :disabled="!input.trim() || optimizing || running"
          @click="optimizePrompt"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c.3 3.5 1.8 5.4 5.5 6-3.7.6-5.2 2.5-5.5 6-.3-3.5-1.8-5.4-5.5-6 3.7-.6 5.2-2.5 5.5-6zM19 14c.1 1.4.7 2 2 2-1.3.1-1.9.7-2 2-.1-1.3-.7-1.9-2-2 1.3-.1 1.9-.7 2-2z"/></svg>
        </button>
      </div>

      <!-- @ 文件 或 / 技能 候选下拉 -->
      <div v-if="dropdownOpen" class="ref-dropdown">
        <!-- 文件引用 -->
        <template v-if="dropdownKind === 'file'">
          <div v-if="!fileItems.length" class="ref-item ref-empty">无匹配文件</div>
          <div
            v-for="(f, i) in fileItems" :key="f"
            class="ref-item" :class="{ active: i === activeIndex }"
            @mousedown.prevent="pickFile(f)"
            @mouseenter="activeIndex = i"
          >
            <span class="ref-icon">{{ f.endsWith('/') ? '📁' : '📄' }}</span>
            <span class="ref-path">{{ f }}</span>
          </div>
        </template>
        <!-- 技能 -->
        <template v-else>
          <div v-if="!skillItems.length" class="ref-item ref-empty">无匹配技能，可在设置中新建</div>
          <div
            v-for="(s, i) in skillItems" :key="s.name"
            class="ref-item skill" :class="{ active: i === activeIndex }"
            @mousedown.prevent="pickSkill(s)"
            @mouseenter="activeIndex = i"
          >
            <span class="ref-icon">✨</span>
            <span class="ref-path">
              <span class="skill-title">{{ s.title }}</span>
              <span class="skill-sub">{{ s.preview.slice(0, 40) }}</span>
            </span>
          </div>
        </template>
      </div>

      <!-- 底部工具栏（容器内） -->
      <div class="composer-bar">
        <button class="icon-btn plus" title="添加（开发中）" type="button">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <!-- 权限审批 -->
        <AgentPermissionPop />
        <!-- Agent 类型 -->
        <AgentSelectPop @change="(m: 'chat'|'agent') => agentMode = m" />
        <span class="spacer"></span>
        <!-- 模型选择 -->
        <button class="text-btn model" title="选择模型" @click="showModelPop = true">
          <span class="model-name">{{ modelShort }}</span>
          <svg class="chev" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        </button>
        <!-- 语音 -->
        <button class="icon-btn mic" title="语音输入（开发中）" type="button">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>
        </button>
        <!-- 发送 / 停止：绿色圆角方块 -->
        <button v-if="!running" class="send-btn" :disabled="!input.trim()" title="发送" @click="send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
        </button>
        <button v-else class="send-btn stop" title="停止任务" @click="stop">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        </button>
      </div>

      <!-- 模型选择弹窗 -->
      <van-popup
        v-model:show="showModelPop"
        position="bottom"
        :style="{ maxWidth: '300px', margin: '0 auto', borderRadius: '8px' }"
        close-on-click-overlay
        class="pop-dark"
      >
        <div class="pop-header">
          <span class="pop-title">选择模型</span>
          <a class="pop-link" @click="showModelPop = false; vscodeApi.postMessage({ type: 'openSettingsTab' })">更多设置</a>
        </div>
        <div class="pop-list">
          <div
            v-for="(label, key) in modelPresets" :key="key"
            class="pop-item"
            :class="{ active: currentProvider === key }"
            @click="selectModel(String(key))"
          >
            <span class="pop-icon">⚡</span>
            <div class="pop-text">
              <div class="pop-item-title">{{ label }}</div>
              <div class="pop-item-desc">{{ modelNames[key] || '' }}</div>
            </div>
            <span v-if="currentProvider === String(key)" class="pop-check">✓</span>
          </div>
        </div>
      </van-popup>

      <!-- 提示条（提示词优化结果） -->
      <div v-if="toast" class="toast-bar">{{ toast }}</div>

      <!-- 历史任务小卡片弹层（类似悬浮菜单） -->
      <div v-if="showHistory" class="hist-card" @click="showHistory = false">
        <div class="pop-header">
          <span class="pop-title">历史任务</span>
          <a class="pop-link" @click.stop="newSession">＋ 新建会话</a>
        </div>
        <div class="hist-list">
          <div v-if="!sessions.length" class="hist-empty">暂无历史会话</div>
          <div
            v-for="s in sessions" :key="s.id"
            class="hist-item" :class="{ active: s.id === activeId }"
            @click.stop="openHistoryItem(s.id)"
          >
            <!-- 删除确认态 -->
            <div v-if="confirmDeleteId === s.id" class="hist-confirm" @click.stop>
              <span>删除该会话？</span>
              <button class="hist-yes" @click.stop="doDelete(s.id)">删除</button>
              <button class="hist-no" @click.stop="confirmDeleteId = ''">取消</button>
            </div>
            <template v-else>
              <div class="hist-text">
                <div class="hist-title">{{ s.title }}<span v-if="s.id === activeId" class="hist-badge">当前</span></div>
                <div class="hist-time">{{ relTime(s.updatedAt) }}</div>
              </div>
              <button class="hist-del" title="删除会话" @click.stop="askDelete(s.id)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13"/></svg>
              </button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
