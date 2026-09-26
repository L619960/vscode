<script setup lang="ts">
// 对话视图：消息流 + 工具卡片（含审批按钮）+ 输入区
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { vscodeApi } from '../main'

interface ToolRun {
  id: string
  name: string
  argsSummary: string
  status: 'running' | 'awaiting' | 'done' | 'error' | 'rejected'
  resultSummary: string
}
interface Msg {
  role: 'user' | 'assistant'
  content: string
  time: string
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

const messages = ref<Msg[]>([])
const running = ref(false)
const input = ref('')
const approvals = ref<Array<Approval & { runKey: string }>>([])
// 可回滚的快照数量（>0 时显示回滚按钮）
const checkpoints = ref(0)

const TOOL_LABELS: Record<string, string> = {
  list_dir: '列出目录', read_file: '读取文件', write_file: '写入文件',
  edit_file: '编辑文件', run_command: '运行命令', search_files: '搜索文件',
  web_search: '联网搜索',
}

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
    }
  })
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
const msgListEl = ref<HTMLElement | null>(null)
watch(messages, async () => {
  await nextTick()
  if (msgListEl.value) msgListEl.value.scrollTop = msgListEl.value.scrollHeight
}, { deep: true, flush: 'post' })
</script>

<template>
  <div class="chat-view">
    <div class="msg-list" ref="msgListEl">
      <div v-if="messages.length === 0" class="empty">
        <p>👋 描述你的任务</p>
        <span>AI 会读项目、改文件、跑命令</span>
      </div>
      <template v-for="(m, i) in messages" :key="i">
        <div class="msg" :class="m.role">
          <div class="bubble">{{ m.content }}</div>
        </div>
        <!-- 工具卡片 -->
        <div v-for="t in m.toolRuns || []" :key="t.id" class="tool-card" :class="t.status">
          <div class="tc-head">
            <span class="tc-dot"></span>
            <span class="tc-label">{{ TOOL_LABELS[t.name] || t.name }}</span>
            <span class="tc-args">{{ t.argsSummary }}</span>
            <span class="tc-status">{{
              t.status === 'running' ? '执行中' : t.status === 'awaiting' ? '待批准'
              : t.status === 'done' ? '完成' : t.status === 'rejected' ? '已拒绝' : '失败'
            }}</span>
          </div>
          <template v-if="t.status !== 'done' && t.resultSummary">
            <div class="tc-result">{{ t.resultSummary }}</div>
          </template>
          <!-- 审批按钮 -->
          <template v-if="t.status === 'awaiting' && approvalFor(t)">
            <div class="tc-actions" v-if="!rejectMode[approvalFor(t)!.id]">
              <button class="mini primary" @click="decide(approvalFor(t)!, 'allow')">允许</button>
              <button class="mini" @click="decide(approvalFor(t)!, 'deny')">拒绝</button>
              <button class="mini" @click="decide(approvalFor(t)!, 'always')">本次会话免审批</button>
              <button v-if="hasDiff(approvalFor(t)!)" class="mini" @click="decide(approvalFor(t)!, 'allow', { viewDiff: true })">查看 Diff</button>
              <span v-if="approvalFor(t)?.danger" class="danger-tag">⚠ 危险命令</span>
            </div>
            <div v-else class="reject-row">
              <input v-model="rejectReason" placeholder="拒绝原因（可选，会反馈给 AI）" @keydown.enter="decide(approvalFor(t)!, 'deny')" />
              <button class="mini primary" @click="decide(approvalFor(t)!, 'deny')">确认</button>
            </div>
          </template>
        </div>
      </template>
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
        <button class="link" @click="clearHistory">清空</button>
        <button v-if="checkpoints > 0" class="link no-push" @click="rollback">回滚({{ checkpoints }})</button>
        <button v-if="!running" class="btn primary" :disabled="!input.trim()" @click="send">发送</button>
        <button v-else class="btn danger" @click="stop">■ 停止</button>
      </div>
    </div>
  </div>
</template>
