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

const TOOL_LABELS: Record<string, string> = {
  list_dir: '列出目录', read_file: '读取文件', write_file: '写入文件',
  edit_file: '编辑文件', run_command: '运行命令', search_files: '搜索文件',
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
      // 清理已完成审批
      approvals.value = approvals.value.filter((a) => !!findAwaitingRun(a.toolName, a.argsSummary))
      attachApprovals()
    } else if (m.type === 'approval') {
      const { type, id, ...req } = m
      approvals.value.push({ id, ...(req as Omit<Approval, 'id'>), runKey: '' })
      attachApprovals()
    }
  })
})

function send(): void {
  const text = input.value.trim()
  if (!text || running.value) return
  vscodeApi.postMessage({ type: 'send', text })
  input.value = ''
}
function stop(): void { vscodeApi.postMessage({ type: 'stop' }) }
function clearHistory(): void {
  if (confirm('确定清空当前会话？')) vscodeApi.postMessage({ type: 'clear' })
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
      <textarea
        v-model="input"
        rows="3"
        :placeholder="running ? 'AI 正在工作…' : '描述你的任务…'"
        @keydown.enter.exact.prevent="running ? stop() : send()"
      ></textarea>
      <div class="input-bar">
        <button class="link" @click="clearHistory">清空</button>
        <button v-if="!running" class="btn primary" :disabled="!input.trim()" @click="send">发送</button>
        <button v-else class="btn danger" @click="stop">■ 停止</button>
      </div>
    </div>
  </div>
</template>
