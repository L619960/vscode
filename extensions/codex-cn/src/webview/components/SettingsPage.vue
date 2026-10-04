<script setup lang="ts">
// 设置标签页：左导航 + 右内容。所有变更即时保存、真实生效。
import { ref, computed, onMounted } from 'vue'
import { vscodeApi } from '../main'

interface NavItem { key: string; icon: string; label: string }
const NAV: NavItem[] = [
  { key: 'model', icon: '🧠', label: '模型' },
  { key: 'approval', icon: '🛡️', label: '权限审批' },
  { key: 'general', icon: '⚙️', label: '通用' },
  { key: 'tools', icon: '🧰', label: '工具开关' },
  { key: 'mcp', icon: '🔌', label: 'MCP 工具' },
  { key: 'privacy', icon: '🔒', label: '隐私模式' },
  { key: 'session', icon: '💬', label: '对话流' },
  { key: 'skills', icon: '✨', label: '技能与命令' },
]

const active = ref('model')
const cfg = ref<Record<string, any>>({})
const savedHint = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | undefined
function flashSaved(): void {
  savedHint.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => { savedHint.value = false }, 1600)
}

// ---- 与扩展宿主通信（seq 匹配一次性回调）----
let seq = 0
const waiters = new Map<number, { resolve: (v: any) => void; reject: (e: string) => void }>()
function call(type: string, extra: Record<string, unknown> = {}): Promise<any> {
  const s = ++seq
  return new Promise((resolve, reject) => {
    waiters.set(s, { resolve, reject })
    vscodeApi.postMessage({ type, seq: s, ...extra })
  })
}

/** 即时保存部分配置并乐观更新 */
function patch(p: Record<string, any>): void {
  Object.assign(cfg.value, p)
  void call('saveConfig', { patch: p })
  flashSaved()
}

// ---- 测试 API 地址：拉取可用模型列表，自动填充模型名称 ----
const modelsLoading = ref(false)
const modelError = ref('')
const fetchedModels = ref<string[]>([])
const showModelsPop = ref(false)

/** 请求当前 API 地址的 /models 端点；单个模型直接填充，多个模型弹层选择 */
async function fetchModels(): Promise<void> {
  const baseUrl = String(cfg.value.baseUrl || '').trim()
  if (!baseUrl) { modelError.value = '请先填写 API 地址'; return }
  modelsLoading.value = true
  modelError.value = ''
  try {
    const result = await call('fetchModels', { baseUrl, model: cfg.value.model }) as { models?: string[]; error?: string; note?: string }
    if (result.error) {
      modelError.value = result.error
    } else if (result.models?.length) {
      if (result.models.length === 1) {
        patch({ model: result.models[0] })
        if (result.note) modelError.value = result.note
      } else {
        fetchedModels.value = result.models
        showModelsPop.value = true
      }
    }
  } catch (e) { modelError.value = String(e) }
  modelsLoading.value = false
}

/** 选中模型：即时保存并关闭弹层 */
function pickModel(id: string): void {
  patch({ model: id })
  showModelsPop.value = false
}

// ---- MCP 服务器（外部工具，热增删/重连）----
interface McpServer {
  name: string
  status: 'connecting' | 'connected' | 'error'
  error: string
  toolCount: number
  tools: Array<{ name: string; description: string }>
  config: {
    type?: 'stdio' | 'http'
    command?: string
    args?: string[]
    env?: Record<string, string>
    url?: string
  }
}
const mcpServers = ref<McpServer[]>([])
const mcpError = ref('')
const mcpLoading = ref(false)
const showMcpForm = ref(false)
const mcpForm = ref({
  name: '',
  type: 'stdio' as 'stdio' | 'http',
  command: '',
  argsText: '',
  url: '',
})

/** 已连接服务器数量 */
const mcpConnected = computed(() => mcpServers.value.filter(s => s.status === 'connected').length)

/** 状态中文文案 */
function statusText(status: McpServer['status']): string {
  return status === 'connected' ? '已连接' : status === 'connecting' ? '连接中' : '连接失败'
}

async function loadMcp(): Promise<void> {
  try { mcpServers.value = await call('mcpList') } catch (e) { mcpError.value = String(e) }
}

/** 打开新增表单 */
function openMcpCreate(): void {
  mcpForm.value = { name: '', type: 'stdio', command: '', argsText: '', url: '' }
  mcpError.value = ''
  showMcpForm.value = true
}

/** 打开编辑表单，回填现有配置 */
function openMcpEdit(s: McpServer): void {
  mcpForm.value = {
    name: s.name,
    type: s.config.type === 'http' ? 'http' : 'stdio',
    command: s.config.command ?? '',
    argsText: (s.config.args ?? []).join(' '),
    url: s.config.url ?? '',
  }
  mcpError.value = ''
  showMcpForm.value = true
}

/** 保存并连接（后端持久化 + 热重连） */
async function saveMcp(): Promise<void> {
  const f = mcpForm.value
  const name = f.name.trim()
  if (!name) { mcpError.value = '请填写服务器名称'; return }
  const config = f.type === 'http'
    ? { type: 'http', url: f.url.trim() }
    : { type: 'stdio', command: f.command.trim(), args: f.argsText.split(/\s+/).filter(Boolean) }
  mcpLoading.value = true
  mcpError.value = ''
  try {
    await call('mcpUpsert', { name, config })
    showMcpForm.value = false
  } catch (e) { mcpError.value = String(e) }
  mcpLoading.value = false
}

async function removeMcp(s: McpServer): Promise<void> {
  mcpError.value = ''
  try { await call('mcpRemove', { name: s.name }) } catch (e) { mcpError.value = String(e) }
}

async function reconnectMcp(s: McpServer): Promise<void> {
  mcpError.value = ''
  try { await call('mcpReconnect', { name: s.name }) } catch (e) { mcpError.value = String(e) }
}

onMounted(() => {
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data
    if (!m) return
    if (m.type === 'config') { cfg.value = m.data; return }
    if (m.type === 'configSaved') {
      flashSaved()
      // 配置已真实落盘：结算本次 saveConfig 调用，并用磁盘真值校正乐观 UI（防竞态导致的假开关状态）
      const wSave = m.seq ? waiters.get(m.seq) : undefined
      if (wSave) { waiters.delete(m.seq); wSave.resolve(true) }
      void call('getConfig').then((d) => { cfg.value = d }).catch(() => undefined)
      return
    }
    if (m.type === 'mcpSaved') {
      // 保存已落盘：结算调用，全量刷新服务器卡片；连接错误显示在卡片与提示条上
      const wMcp = m.seq ? waiters.get(m.seq) : undefined
      if (wMcp) { waiters.delete(m.seq); wMcp.resolve(true) }
      mcpServers.value = m.servers || []
      mcpError.value = m.error || ''
      return
    }
    const w = m.seq ? waiters.get(m.seq) : undefined
    if (!w) return
    waiters.delete(m.seq)
    if (m.error) w.reject(m.error)
    else if (m.type === 'skills') w.resolve(m.items || [])
    else if (m.type === 'skillContent') w.resolve(m.content || '')
    else if (m.type === 'modelsList') w.resolve(m.models || [])
    else if (m.type === 'mcpList') w.resolve(m.servers || [])
    else w.resolve(true)
  })
  void call('getConfig').catch(() => undefined)
  void loadSkills()
  void loadMcp()
})

// ---- 技能（真实 .md 文件）----
interface SkillItem { name: string; title: string; preview: string; linked?: boolean }
const skills = ref<SkillItem[]>([])
const editingName = ref('')
const editingContent = ref('')
const skillDirty = ref(false)
const skillError = ref('')
const showCreate = ref(false)
const newSkillName = ref('')

// 批量管理
const skillSearch = ref('')
const skillFilter = ref<'all' | 'linked' | 'unlinked'>('all')
const selectedSkills = ref<Set<string>>(new Set())
const batchLoading = ref(false)

/** 过滤后的技能列表 */
const filteredSkills = computed(() => {
  const q = skillSearch.value.toLowerCase().trim()
  return skills.value.filter((s) => {
    // 搜索过滤
    if (q && !s.title.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q) && !s.preview.toLowerCase().includes(q)) {
      return false
    }
    // 关联状态过滤
    if (skillFilter.value === 'linked' && !s.linked) return false
    if (skillFilter.value === 'unlinked' && s.linked) return false
    return true
  })
})

/** 全选/取消全选 */
const allSelected = computed(() => {
  const filtered = filteredSkills.value
  return filtered.length > 0 && filtered.every((s) => selectedSkills.value.has(s.name))
})

function toggleSelectAll(): void {
  if (allSelected.value) {
    selectedSkills.value.clear()
  } else {
    filteredSkills.value.forEach((s) => selectedSkills.value.add(s.name))
  }
}

function toggleSelect(name: string): void {
  if (selectedSkills.value.has(name)) {
    selectedSkills.value.delete(name)
  } else {
    selectedSkills.value.add(name)
  }
}

/** 批量关联 */
async function batchLink(): Promise<void> {
  const names = [...selectedSkills.value]
  if (!names.length) return
  batchLoading.value = true
  skillError.value = ''
  try {
    await call('linkSkills', { names })
    // 更新本地状态
    skills.value.forEach((s) => {
      if (names.includes(s.name)) s.linked = true
    })
    selectedSkills.value.clear()
    flashSaved()
  } catch (e) { skillError.value = String(e) }
  batchLoading.value = false
}

/** 批量取消关联 */
async function batchUnlink(): Promise<void> {
  const names = [...selectedSkills.value]
  if (!names.length) return
  batchLoading.value = true
  skillError.value = ''
  try {
    await call('unlinkSkills', { names })
    // 更新本地状态
    skills.value.forEach((s) => {
      if (names.includes(s.name)) s.linked = false
    })
    selectedSkills.value.clear()
    flashSaved()
  } catch (e) { skillError.value = String(e) }
  batchLoading.value = false
}

/** 单个技能切换关联状态 */
async function toggleLink(item: SkillItem): Promise<void> {
  const action = item.linked ? 'unlinkSkills' : 'linkSkills'
  try {
    await call(action, { names: [item.name] })
    item.linked = !item.linked
    flashSaved()
  } catch (e) { skillError.value = String(e) }
}

async function loadSkills(): Promise<void> {
  try { skills.value = await call('listSkills') } catch (e) { skillError.value = String(e) }
}

async function saveCurrent(silent = false): Promise<boolean> {
  if (!editingName.value) return true
  try {
    await call('saveSkill', { name: editingName.value, content: editingContent.value })
    skillDirty.value = false
    skillError.value = ''
    if (!silent) flashSaved()
    return true
  } catch (e) { skillError.value = String(e); return false }
}

/** 切换技能前自动保留未保存修改 */
async function openSkill(item: SkillItem): Promise<void> {
  if (skillDirty.value) {
    const ok = await saveCurrent(true)
    if (!ok) return
  }
  try {
    editingName.value = item.name
    editingContent.value = await call('readSkill', { name: item.name })
    skillDirty.value = false
    skillError.value = ''
  } catch (e) { skillError.value = String(e) }
}

function markDirty(): void { skillDirty.value = true }

async function deleteCurrent(): Promise<void> {
  if (!editingName.value) return
  try {
    await call('deleteSkill', { name: editingName.value })
    editingName.value = ''
    editingContent.value = ''
    skillDirty.value = false
    await loadSkills()
    flashSaved()
  } catch (e) { skillError.value = String(e) }
}

async function createSkill(): Promise<void> {
  let name = newSkillName.value.trim()
  if (!name) return
  if (!/\.md$/i.test(name)) name += '.md'
  try {
    await call('createSkill', { name })
    showCreate.value = false
    newSkillName.value = ''
    await loadSkills()
    const item = skills.value.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (item) await openSkill(item)
    active.value = 'skills'
    flashSaved()
  } catch (e) { skillError.value = String(e) }
}

function asChecked(e: Event): boolean { return (e.target as HTMLInputElement).checked }
function asNumber(e: Event): number { return Number((e.target as HTMLInputElement).value) }
</script>

<template>
  <div class="set-page">
    <aside class="set-nav">
      <div class="set-brand"><span class="brand-bolt">⚡</span>设置</div>
      <button
        v-for="n in NAV" :key="n.key" type="button"
        class="nav-item" :class="{ on: active === n.key }"
        @click="active = n.key"
      >
        <span class="nav-ico">{{ n.icon }}</span>{{ n.label }}
      </button>
      <div class="nav-foot">Codex CN · 本地优先<br />不收集任何数据</div>
    </aside>

    <main class="set-main">
      <Transition name="fade">
        <div v-if="savedHint" class="saved-float">✓ 已保存并即时生效</div>
      </Transition>

      <!-- 模型 -->
      <section v-show="active === 'model'" class="set-sec">
        <h2 class="sec-title">模型</h2>
        <p class="sec-sub">配置对话与 Agent 使用的模型；本地地址（127.0.0.1）无需 API Key</p>
        <div class="set-card">
          <div class="field">
            <label>模型提供商</label>
            <select :value="cfg.provider" @change="(e) => patch({ provider: (e.target as HTMLSelectElement).value })">
              <option v-for="(label, key) in cfg.presets" :key="key" :value="key">{{ label }}</option>
            </select>
            <span class="hint">切换后自动填充对应的 API 地址与模型名</span>
          </div>
          <div class="field">
            <label>API 地址</label>
            <div class="field-row">
              <input :value="cfg.baseUrl" spellcheck="false"
                @change="(e) => patch({ baseUrl: (e.target as HTMLInputElement).value.trim() })" />
              <button type="button" class="btn primary fetch-btn" :disabled="modelsLoading"
                @click="fetchModels">
                {{ modelsLoading ? '测试中…' : '测试获取模型' }}
              </button>
            </div>
            <span class="hint">点击「测试获取模型」自动检测并填充可用模型名称</span>
          </div>
          <div class="field">
            <label>API Key</label>
            <input type="password" spellcheck="false" :placeholder="cfg.hasKey ? '已配置，输入新值可覆盖' : 'sk-...'"
              @change="(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v) patch({ apiKey: v }); (e.target as HTMLInputElement).value = '' }" />
            <span class="hint">通过 VS Code SecretStorage 加密存储，不写入本地文件</span>
          </div>
          <div class="field">
            <label>模型名称</label>
            <input :value="cfg.model" spellcheck="false"
              @change="(e) => patch({ model: (e.target as HTMLInputElement).value.trim() })" />
          </div>
          <div class="field">
            <label>工具调用</label>
            <select :value="cfg.supportsTools" @change="(e) => patch({ supportsTools: (e.target as HTMLSelectElement).value })">
              <option value="auto">自动检测（不支持时自动降级纯对话）</option>
              <option value="yes">强制启用</option>
              <option value="no">关闭（纯对话）</option>
            </select>
          </div>
          <div v-if="modelError" class="set-error">⚠️ {{ modelError }}</div>
        </div>

        <!-- 模型选择弹层：接口返回多个模型时展示 -->
        <van-popup v-model:show="showModelsPop" position="bottom" round teleport="body">
          <div class="models-pop">
            <div class="create-title">选择模型（{{ fetchedModels.length }} 个可用）</div>
            <div class="models-list">
              <button
                v-for="id in fetchedModels" :key="id" type="button"
                class="model-option" :class="{ on: cfg.model === id }"
                @click="pickModel(id)"
              >
                <span>{{ id }}</span>
                <span v-if="cfg.model === id" class="model-current">当前</span>
              </button>
            </div>
          </div>
        </van-popup>
      </section>

      <!-- 权限审批 -->
      <section v-show="active === 'approval'" class="set-sec">
        <h2 class="sec-title">权限审批</h2>
        <p class="sec-sub">控制 Agent 执行高风险操作前是否需要你确认</p>
        <div class="set-card">
          <div class="row">
            <div class="row-txt">
              <div class="row-name">自动审批</div>
              <div class="row-desc">开启后写文件、编辑文件、运行普通命令不再弹窗询问</div>
            </div>
            <input type="checkbox" class="tg" :checked="!!cfg.autoApprove"
              @change="patch({ autoApprove: asChecked($event) })" />
          </div>
          <div class="row">
            <div class="row-txt">
              <div class="row-name">计划确认模式</div>
              <div class="row-desc">AI 动手前先提交实施方案，获你批准后才执行写/命令类操作（对标 Trae Plan 模式）</div>
            </div>
            <input type="checkbox" class="tg" :checked="!!cfg.planMode"
              @change="patch({ planMode: asChecked($event) })" />
          </div>
          <div class="row">
            <div class="row-txt">
              <div class="row-name">Superpowers 方法论</div>
              <div class="row-desc">复杂任务先头脑风暴澄清需求 → 规格 → 计划 → TDD → 代码评审再交付（obra/superpowers v6.4.2）。会增加上下文占用，简单任务无需开启</div>
            </div>
            <input type="checkbox" class="tg" :checked="!!cfg.superpowers"
              @change="patch({ superpowers: asChecked($event) })" />
          </div>
          <div class="set-note">⚠️ <strong>rm -rf、del /s、format、shutdown</strong> 等危险命令始终需要人工确认，自动审批不覆盖危险操作</div>
        </div>
      </section>

      <!-- 通用 -->
      <section v-show="active === 'general'" class="set-sec">
        <h2 class="sec-title">通用</h2>
        <p class="sec-sub">编辑器内的辅助能力</p>
        <div class="set-card">
          <div class="row">
            <div class="row-txt">
              <div class="row-name">Tab 代码补全</div>
              <div class="row-desc">在编辑器中给出 AI 行内补全建议，按 Tab 接受</div>
            </div>
            <input type="checkbox" class="tg" :checked="cfg.tabCompletion !== false"
              @change="patch({ tabCompletion: asChecked($event) })" />
          </div>
          <div class="row">
            <div class="row-txt">
              <div class="row-name">🐾 单步模式</div>
              <div class="row-desc">每轮决策前暂停，点「下一步」执行；运行中也可随时开关</div>
            </div>
            <input type="checkbox" class="tg" :checked="!!cfg.stepMode"
              @change="patch({ stepMode: asChecked($event) })" />
          </div>
        </div>
      </section>

      <!-- 工具开关 -->
      <section v-show="active === 'tools'" class="set-sec">
        <h2 class="sec-title">工具开关</h2>
        <p class="sec-sub">关闭后 Agent 调用对应工具会被<strong>真实拦截</strong>（错误结果回传，工具不会执行）</p>
        <div class="set-card">
          <div class="row">
            <div class="row-txt"><div class="row-name">📄 文件读取</div>
              <div class="row-desc">read_file / list_dir / search_files / glob / read_lints</div></div>
            <input type="checkbox" class="tg" :checked="!!cfg.toolRead"
              @change="patch({ toolRead: asChecked($event) })" />
          </div>
          <div class="row">
            <div class="row-txt"><div class="row-name">✏️ 文件写入</div>
              <div class="row-desc">write_file / edit_file，关闭后 Agent 无法修改任何文件</div></div>
            <input type="checkbox" class="tg" :checked="!!cfg.toolWrite"
              @change="patch({ toolWrite: asChecked($event) })" />
          </div>
          <div class="row">
            <div class="row-txt"><div class="row-name">⚡ 命令执行</div>
              <div class="row-desc">run_command / 后台进程启动（查看、停止等管理操作不受影响）</div></div>
            <input type="checkbox" class="tg" :checked="!!cfg.toolShell"
              @change="patch({ toolShell: asChecked($event) })" />
          </div>
          <div class="row">
            <div class="row-txt"><div class="row-name">🌐 浏览器</div>
              <div class="row-desc">browser_*，基于系统自带 Edge 浏览器</div></div>
            <input type="checkbox" class="tg" :checked="!!cfg.toolBrowser"
              @change="patch({ toolBrowser: asChecked($event) })" />
          </div>
          <div class="row">
            <div class="row-txt"><div class="row-name">🔍 联网</div>
              <div class="row-desc">web_search / web_fetch，关闭后 Agent 无法联网</div></div>
            <input type="checkbox" class="tg" :checked="!!cfg.toolWeb"
              @change="patch({ toolWeb: asChecked($event) })" />
          </div>
        </div>
      </section>

      <!-- MCP 工具 -->
      <section v-show="active === 'mcp'" class="set-sec">
        <h2 class="sec-title">MCP 工具</h2>
        <p class="sec-sub">接入外部工具服务器（Model Context Protocol），Agent 可自动发现并调用其工具；保存后立即生效</p>

        <div class="mcp-toolbar">
          <button type="button" class="btn primary" @click="openMcpCreate">＋ 添加服务器</button>
          <span class="mcp-total" v-if="mcpServers.length">
            共 {{ mcpServers.length }} 个 · {{ mcpConnected }} 个已连接
          </span>
        </div>

        <div class="mcp-list">
          <div v-for="s in mcpServers" :key="s.name" class="mcp-card">
            <div class="mcp-head">
              <span class="mcp-name">{{ s.name }}</span>
              <span class="mcp-state" :class="s.status">
                <i class="dot"></i>{{ statusText(s.status) }}
              </span>
            </div>
            <div class="mcp-cfg">
              <template v-if="(s.config.type || 'stdio') === 'http'">{{ s.config.url }}</template>
              <template v-else>
                {{ s.config.command }}<span v-if="s.config.args && s.config.args.length"> {{ s.config.args.join(' ') }}</span>
              </template>
            </div>
            <div v-if="s.status === 'error'" class="mcp-err">⚠️ {{ s.error }}</div>
            <div v-if="s.tools.length" class="mcp-tools">
              <span v-for="t in s.tools" :key="t.name" class="mcp-tool-tag" :title="t.description">{{ t.name }}</span>
            </div>
            <div class="mcp-actions">
              <button type="button" class="btn" @click="reconnectMcp(s)">重连</button>
              <button type="button" class="btn" @click="openMcpEdit(s)">编辑</button>
              <button type="button" class="btn danger" @click="removeMcp(s)">移除</button>
            </div>
          </div>
          <div v-if="!mcpServers.length" class="mcp-empty">尚未添加 MCP 服务器，点击「添加服务器」接入</div>
        </div>
        <div v-if="mcpError" class="set-error">⚠️ {{ mcpError }}</div>

        <van-popup v-model:show="showMcpForm" position="bottom" round teleport="body">
          <div class="mcp-form">
            <div class="create-title">{{ mcpForm.name ? '编辑 MCP 服务器' : '添加 MCP 服务器' }}</div>
            <label class="mcp-label">服务器名称</label>
            <input v-model="mcpForm.name" class="create-input" placeholder="如 everything" spellcheck="false" />
            <label class="mcp-label">传输方式</label>
            <select v-model="mcpForm.type" class="mcp-select">
              <option value="stdio">stdio（本地进程）</option>
              <option value="http">HTTP（远程服务）</option>
            </select>
            <template v-if="mcpForm.type === 'stdio'">
              <label class="mcp-label">启动命令</label>
              <input v-model="mcpForm.command" class="create-input" placeholder="如 npx" spellcheck="false" />
              <label class="mcp-label">参数（空格分隔；路径含空格请改用 settings.json 配置）</label>
              <input v-model="mcpForm.argsText" class="create-input"
                placeholder="-y @modelcontextprotocol/server-everything" spellcheck="false" />
            </template>
            <template v-else>
              <label class="mcp-label">服务 URL</label>
              <input v-model="mcpForm.url" class="create-input" placeholder="http://127.0.0.1:3000/mcp" spellcheck="false" />
            </template>
            <div class="create-actions">
              <button type="button" class="btn" @click="showMcpForm = false">取消</button>
              <button type="button" class="btn primary" :disabled="mcpLoading" @click="saveMcp">
                {{ mcpLoading ? '连接中…' : '保存并连接' }}
              </button>
            </div>
          </div>
        </van-popup>
      </section>

      <!-- 隐私模式 -->
      <section v-show="active === 'privacy'" class="set-sec">
        <h2 class="sec-title">隐私模式</h2>
        <p class="sec-sub">防止代码片段随联网工具外发</p>
        <div class="set-card">
          <div class="row">
            <div class="row-txt">
              <div class="row-name">隐私模式</div>
              <div class="row-desc">开启后阻止 web_search / web_fetch 一切联网请求</div>
            </div>
            <input type="checkbox" class="tg" :checked="!!cfg.privacyMode"
              @change="patch({ privacyMode: asChecked($event) })" />
          </div>
          <div class="set-note">
            隐私模式与「工具开关 → 联网」<strong>独立生效</strong>：任一开启都会拦截联网请求。<br />
            模型对话本身仍会发送至你配置的模型服务地址，请在可信网络环境使用。
          </div>
        </div>
      </section>

      <!-- 对话流 -->
      <section v-show="active === 'session'" class="set-sec">
        <h2 class="sec-title">对话流</h2>
        <p class="sec-sub">会话与历史消息的保留策略，修改即时生效</p>
        <div class="set-card">
          <div class="row">
            <div class="row-txt">
              <div class="row-name">单会话消息保留条数</div>
              <div class="row-desc">超出后最旧的消息不落盘（20–500）</div>
            </div>
            <input type="number" class="num" min="20" max="500" :value="cfg.maxMessages"
              @change="(e) => patch({ maxMessages: Math.min(500, Math.max(20, asNumber(e))) })" />
          </div>
          <div class="row">
            <div class="row-txt">
              <div class="row-name">自动生成会话标题</div>
              <div class="row-desc">关闭后新会话统一命名为「新会话」</div>
            </div>
            <input type="checkbox" class="tg" :checked="cfg.autoTitle !== false"
              @change="patch({ autoTitle: asChecked($event) })" />
          </div>
          <div class="row">
            <div class="row-txt">
              <div class="row-name">历史会话保留上限</div>
              <div class="row-desc">超出后最旧的会话被真实删除（10–200）</div>
            </div>
            <input type="number" class="num" min="10" max="200" :value="cfg.maxSessions"
              @change="(e) => patch({ maxSessions: Math.min(200, Math.max(10, asNumber(e))) })" />
          </div>
        </div>
      </section>

      <!-- 技能与命令 -->
      <section v-show="active === 'skills'" class="set-sec">
        <h2 class="sec-title">技能与命令</h2>
        <p class="sec-sub">技能是保存在本机的提示词模板；Agent 仅加载已关联到当前项目的技能</p>

        <!-- 批量管理工具栏 -->
        <div class="skill-toolbar">
          <div class="skill-search-row">
            <input
              v-model="skillSearch" class="skill-search" placeholder="搜索技能名称、内容..."
              @keydown.esc="skillSearch = ''"
            />
            <select v-model="skillFilter" class="skill-filter">
              <option value="all">全部</option>
              <option value="linked">已关联</option>
              <option value="unlinked">未关联</option>
            </select>
          </div>
          <div class="skill-actions">
            <label class="skill-select-all">
              <input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
              <span>全选（{{ filteredSkills.length }} 个）</span>
            </label>
            <span class="skill-count" v-if="selectedSkills.size > 0">
              已选 {{ selectedSkills.size }} 个
            </span>
            <button
              type="button" class="btn primary" :disabled="!selectedSkills.size || batchLoading"
              @click="batchLink"
            >关联</button>
            <button
              type="button" class="btn" :disabled="!selectedSkills.size || batchLoading"
              @click="batchUnlink"
            >取消关联</button>
            <button type="button" class="btn" @click="showCreate = true">＋ 新建技能</button>
          </div>
        </div>

        <!-- 技能列表：双栏布局 -->
        <div class="skill-wrap">
          <div class="skill-list skill-list-linkable">
            <div
              v-for="item in filteredSkills" :key="item.name"
              class="skill-item" :class="{ on: editingName === item.name, linked: item.linked }"
            >
              <input
                type="checkbox" class="skill-check"
                :checked="selectedSkills.has(item.name)"
                @change="toggleSelect(item.name)"
                @click.stop
              />
              <div class="skill-info" @click="openSkill(item)">
                <div class="skill-name">
                  {{ item.title }}
                  <span v-if="item.linked" class="skill-badge">已关联</span>
                </div>
                <div class="skill-preview">{{ item.preview || '（空）' }}</div>
              </div>
            </div>
            <div v-if="!filteredSkills.length" class="skill-empty">暂无匹配技能</div>
          </div>
          <div class="skill-editor">
            <template v-if="editingName">
              <div class="skill-editor-bar">
                <span class="skill-file">{{ editingName }}</span>
                <span v-if="skillDirty" class="skill-dirty">未保存</span>
                <button type="button" class="btn" @click="saveCurrent()">保存</button>
                <button type="button" class="btn danger" @click="deleteCurrent()">删除</button>
              </div>
              <textarea v-model="editingContent" class="skill-text" spellcheck="false"
                @input="markDirty()"></textarea>
            </template>
            <div v-else class="skill-empty">
              从左侧选择一个技能编辑，<br/>或新建技能
            </div>
          </div>
        </div>
        <div v-if="skillError" class="set-error">⚠️ {{ skillError }}</div>

        <van-popup v-model:show="showCreate" position="bottom" round teleport="body">
          <div class="create-pop">
            <div class="create-title">新建技能</div>
            <input v-model="newSkillName" class="create-input" placeholder="技能名称（自动补 .md）"
              @keyup.enter="createSkill" />
            <div class="create-actions">
              <button type="button" class="btn" @click="showCreate = false">取消</button>
              <button type="button" class="btn primary" @click="createSkill">创建</button>
            </div>
          </div>
        </van-popup>
      </section>
    </main>
  </div>
</template>
