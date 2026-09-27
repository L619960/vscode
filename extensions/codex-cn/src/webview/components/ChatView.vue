<script setup lang="ts">
// 对话视图：消息流 + 工具卡片（含审批按钮）+ 输入区
import { ref, computed, onMounted, nextTick, watch, type Ref } from 'vue'
import { vscodeApi } from '../main'
import AgentPermissionPop from './AgentPermissionPop.vue'
import AgentSelectPop from './AgentSelectPop.vue'

interface ToolRun {
  id: string
  name: string
  argsSummary: string
  status: 'running' | 'awaiting' | 'done' | 'error' | 'rejected'
  resultSummary: string
  resultJson?: string   // 结构化结果（diff 行数统计等）
}
interface Msg {
  role: 'user' | 'assistant'
  content: string
  time: string
  ts?: number
  endTs?: number
  toolRuns?: ToolRun[]
}
interface Approval {
  id: string
  toolName: string
  argsSummary: string
  command?: string
  danger?: boolean
  path?: string
  oldContent?: string
  newContent?: string
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
const input = ref('')
const approvals = ref<Array<Approval & { runKey: string }>>([])
// 可回滚的快照数量（>0 时显示回滚按钮）
const checkpoints = ref(0)
// AI 主动任务规划（todo_write）
const todos = ref<TaskCheckpoint[]>([])
const planClosed = ref(false)
/** 规划完成度统计 */
const planStats = computed(() => ({
  total: todos.value.length,
  p0: todos.value.filter((t) => t.priority === 'P0').length,
  done: todos.value.filter((t) => t.status === 'done').length,
  error: todos.value.filter((t) => t.status === 'error').length,
}))

const TOOL_LABELS: Record<string, string> = {
  list_dir: '列出目录', read_file: '读取文件', write_file: '写入文件',
  edit_file: '编辑文件', run_command: '运行命令', search_files: '搜索文件',
  web_search: '联网搜索', glob: '匹配文件名', web_fetch: '抓取网页',
  read_lints: '读取诊断', await_shell: '后台进程', todo_write: '更新规划',
  browser_navigate: '浏览器打开', browser_snapshot: '页面快照', browser_click: '浏览器点击',
  browser_type: '浏览器输入', browser_scroll: '浏览器滚动', browser_screenshot: '页面截图',
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

// 折叠状态：van-collapse v-model（存展开的 name）；工具组明细默认展开、记录收起的
const expandedTurns = ref<number[]>([])   // 外层 Agent 回合（执行中的回合默认展开，历史回合默认折叠）
const thinkActive = ref<string[]>([])     // 思考节点（默认折叠，name 为 回合:节点）
const groupClosed = ref<Set<string>>(new Set())
const seenTurns = new Set<number>()
// 注意：模板里 ref 会自动解包，不能把 ref 当参数传递；Set 操作用专用函数
function flip<T>(setRef: Ref<Set<T>>, key: T): void {
  const next = new Set(setRef.value)
  if (next.has(key)) next.delete(key); else next.add(key)
  setRef.value = next
}
const toggleGroup = (key: string): void => flip(groupClosed, key)

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

/** 把待审批请求关联到唯一的 awaiting run（工具串行执行，同时只有一个） */
function attachApprovals(): void {
  for (const a of approvals.value) {
    const run = findAwaitingRun(a.toolName, a.argsSummary)
    if (run) a.runKey = run.id
  }
}
function findAwaitingRun(toolName: string, argsSummary: string): ToolRun | undefined {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    for (const t of messages.value[i].toolRuns || []) {
      if (t.status === 'awaiting' && t.name === toolName && t.argsSummary === argsSummary) return t
    }
  }
  return undefined
}
function approvalFor(run: ToolRun): Approval | undefined {
  return approvals.value.find((a) => a.runKey === run.id)
}

onMounted(() => {
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data
    if (m.type === 'state') {
      messages.value = m.messages
      running.value = m.running
      checkpoints.value = m.checkpoints ?? 0
      todos.value = m.todos || []
      if (todos.value.length) planClosed.value = false
      // 清理已完成审批
      approvals.value = approvals.value.filter((a) => !!findAwaitingRun(a.toolName, a.argsSummary))
      attachApprovals()
    } else if (m.type === 'approval') {
      const { type, id, ...req } = m
      approvals.value.push({ id, ...(req as Omit<Approval, 'id'>), runKey: '' })
      attachApprovals()
    } else if (m.type === 'workspaceFiles') {
      // 过期响应丢弃（seq 不同说明用户又输入了新字符）
      if (m.seq === fileSeq) fileItems.value = m.files || []
    } else if (m.type === 'config') {
      const d = m.data || {}
      modelPresets.value = d.presets || {}
      modelNames.value = d.presetModels || {}
      currentProvider.value = d.provider || ''
      currentModel.value = d.model || ''
    }
  })
  vscodeApi.postMessage({ type: 'getConfig' })
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
function clearHistory(): void {
  if (confirm('确定清空当前会话？')) vscodeApi.postMessage({ type: 'clear' })
}
// 回滚：由扩展弹原生 QuickPick 选择快照并恢复
function rollback(): void { vscodeApi.postMessage({ type: 'rollback' }) }

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

// ---- @ 文件/文件夹引用 ----
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const references = ref<string[]>([])
const dropdownOpen = ref(false)
const fileItems = ref<string[]>([])
const activeIndex = ref(0)
const mentionStart = ref(-1)
let fileSeq = 0
let fileTimer: number | undefined

/** 输入 / 点击：检测光标前是否处于 @引用 输入中，是则向后端请求文件列表 */
function onInput(): void {
  const el = textareaEl.value
  if (!el) return
  const pos = el.selectionStart
  const m = input.value.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/)
  if (m) {
    mentionStart.value = pos - m[1].length - 1
    dropdownOpen.value = true
    activeIndex.value = 0
    requestFiles(m[1])
  } else {
    closeDropdown()
  }
  syncReferences()
}

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
    if (fileItems.value.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex.value = (activeIndex.value + 1) % fileItems.value.length; return }
      if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex.value = (activeIndex.value - 1 + fileItems.value.length) % fileItems.value.length; return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickFile(fileItems.value[activeIndex.value]); return }
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault()
    if (running.value) stop(); else send()
  }
}

const rejectMode = ref<Record<string, boolean>>({})
const rejectReason = ref('')
function decide(a: Approval, decision: string, extra?: { viewDiff?: boolean }): void {
  if (decision === 'deny' && !rejectMode.value[a.id]) { rejectMode.value[a.id] = true; return }
  vscodeApi.postMessage({
    type: 'decision', id: a.id, decision,
    reason: rejectReason.value.trim() || undefined,
    viewDiff: extra?.viewDiff, req: a,
  })
  rejectMode.value[a.id] = false
  rejectReason.value = ''
}

const hasDiff = (a: Approval): boolean => a.oldContent !== undefined && a.newContent !== undefined
const statusText = computed(() => (running.value ? '停止' : '发送'))

// 自动滚动到底部
// ---- Agent 模式 + 模型选择 ----
const agentMode = ref<'chat' | 'agent'>('agent')
const showModelPop = ref(false)
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
      <div v-if="messages.length === 0" class="empty">
        <p>👋 描述你的任务</p>
        <span>AI 会读项目、改文件、跑命令</span>
      </div>
      <template v-for="(seg, si) in segments" :key="si">
        <!-- 用户提问：紫色气泡 + 时间 + 操作 -->
        <div v-if="seg.user" class="msg user">
          <div class="bubble">{{ seg.user.content }}</div>
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
            <div class="bubble">{{ s.content }}</div>
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
                <!-- 思考：内层 van-collapse，单行预览，点开看全文 -->
                <van-collapse v-if="node.kind === 'think'" v-model="thinkActive" :border="false" class="inner-collapse">
                  <van-collapse-item :name="si + ':' + ni">
                    <template #title>
                      <div class="think-title">
                        <span class="think-label">💡 思考</span>
                        <span v-if="!thinkActive.includes(si + ':' + ni)" class="think-preview">{{ node.text }}</span>
                      </div>
                    </template>
                    <div class="think-body">{{ node.text }}</div>
                  </van-collapse-item>
                </van-collapse>

                <!-- 中间说明文本：全文显示 -->
                <div v-else-if="node.kind === 'text'" class="step">
                  <div class="step-rail"><span class="step-ico">📄</span></div>
                  <div class="step-main">
                    <div class="step-text">{{ node.text }}</div>
                  </div>
                </div>

                <!-- 工具聚合组：明细直接可见 -->
                <div v-else-if="node.kind === 'group'" class="step">
                  <div class="step-rail"><span class="step-ico">{{ GROUP_ICONS[node.group.name] || '🔧' }}</span></div>
                  <div class="step-main">
                    <div class="step-title clickable" :class="{ error: node.group.hasError }" @click="toggleGroup(si + ':' + ni)">
                      {{ node.group.label }}
                      <span class="chev">{{ groupClosed.has(si + ':' + ni) ? '▸' : '▾' }}</span>
                    </div>
                    <div v-if="!groupClosed.has(si + ':' + ni)" class="group-detail">
                      <!-- 变更卡片：写/编辑类工具带 +N -M 统计 -->
                      <div v-for="t in node.group.runs" :key="t.id" class="gd-row" :class="t.status">
                        <span class="gd-name">{{ TOOL_LABELS[t.name] || t.name }}</span>
                        <span class="gd-args">{{ t.argsSummary }}</span>
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

                <!-- 执行中 / 待审批（不聚合，实时呈现） -->
                <div v-else class="step">
                  <div class="step-rail"><span class="step-ico pending">{{ GROUP_ICONS[node.run.name] || '🔧' }}</span></div>
                  <div class="step-main">
                    <div class="step-title" :class="node.run.status">
                      {{ TOOL_LABELS[node.run.name] || node.run.name }} {{ node.run.argsSummary }}
                      <span class="gd-badge" :class="node.run.status">{{ node.run.status === 'awaiting' ? '待批准' : '执行中' }}</span>
                    </div>
                    <div v-if="node.run.resultSummary" class="gd-result">{{ node.run.resultSummary }}</div>
                    <!-- 审批按钮 -->
                    <template v-if="node.run.status === 'awaiting' && approvalFor(node.run)">
                      <div class="tc-actions" v-if="!rejectMode[approvalFor(node.run)!.id]">
                        <button class="mini primary" @click="decide(approvalFor(node.run)!, 'allow')">允许</button>
                        <button class="mini" @click="decide(approvalFor(node.run)!, 'deny')">拒绝</button>
                        <button class="mini" @click="decide(approvalFor(node.run)!, 'always')">本次会话免审批</button>
                        <button v-if="hasDiff(approvalFor(node.run)!)" class="mini" @click="decide(approvalFor(node.run)!, 'allow', { viewDiff: true })">查看 Diff</button>
                        <span v-if="approvalFor(node.run)?.danger" class="danger-tag">⚠ 危险命令</span>
                      </div>
                      <div v-else class="reject-row">
                        <input v-model="rejectReason" placeholder="拒绝原因（可选，会反馈给 AI）" @keydown.enter="decide(approvalFor(node.run)!, 'deny')" />
                        <button class="mini primary" @click="decide(approvalFor(node.run)!, 'deny')">确认</button>
                      </div>
                    </template>
                  </div>
                </div>
              </template>
              </div>
            </div>
          </van-collapse-item>

          <!-- ✅ 最终回复：放在 van-collapse-item 外面，永远可见！ -->
          <div v-if="seg.finalReply" class="step reply-step final-reply">
            <div class="step-rail"><span class="step-ico end"></span></div>
            <div class="step-main">
              <div class="reply-body">{{ seg.finalReply }}</div>
            </div>
          </div>
        </van-collapse>
      </template>

      <!-- 等待模型响应 -->
      <div v-if="showWaiting" class="msg assistant">
        <div class="bubble waiting">AI 等待模型响应…</div>
      </div>
    </div>

    <div class="input-area">
      <!-- @ 引用 chips -->
      <div v-if="references.length" class="ref-chips">
        <span v-for="r in references" :key="r" class="ref-chip">
          {{ r.endsWith('/') ? '📁' : '📄' }} {{ r }}
          <button class="ref-x" title="移除引用" @click="removeReference(r)">×</button>
        </span>
      </div>
      <textarea
        ref="textareaEl"
        v-model="input"
        rows="3"
        :placeholder="running ? 'AI 正在工作…' : '描述你的任务…（输入 @ 引用文件）'"
        @input="onInput"
        @click="onInput"
        @keydown="onKeydown"
      ></textarea>
      <!-- @ 引用候选下拉（位于输入框下方） -->
      <div v-if="dropdownOpen" class="ref-dropdown">
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
      </div>
      <div class="input-bar">
        <!-- 权限审批下拉 -->
        <AgentPermissionPop />
        <!-- Agent 类型选择下拉 -->
        <AgentSelectPop @change="(m: 'chat'|'agent') => agentMode = m" />
        <!-- 模型选择按钮 -->
        <button class="mini-btn" title="模型配置" @click="showModelPop = true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/></svg>
          <span>{{ currentModel || '模型' }}</span>
          <svg class="arrow" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        </button>
        <div class="spacer"></div>
        <button class="link" @click="clearHistory">清空</button>
        <button v-if="checkpoints > 0" class="link no-push" @click="rollback">回滚({{ checkpoints }})</button>
        <button v-if="!running" class="btn primary" :disabled="!input.trim()" @click="send">发送</button>
        <button v-else class="btn danger" @click="stop">■ 停止</button>
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
          <a class="pop-link" @click="showModelPop = false; vscodeApi.postMessage({ type: 'openSettings' })">更多设置</a>
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
    </div>
  </div>
</template>
