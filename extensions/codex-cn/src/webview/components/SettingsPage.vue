<script setup lang="ts">
// 设置标签页：左导航 + 右内容。所有变更即时保存、真实生效。
import { ref, onMounted } from 'vue'
import { vscodeApi } from '../main'

interface NavItem { key: string; icon: string; label: string }
const NAV: NavItem[] = [
  { key: 'model', icon: '🧠', label: '模型' },
  { key: 'approval', icon: '🛡️', label: '权限审批' },
  { key: 'general', icon: '⚙️', label: '通用' },
  { key: 'tools', icon: '🧰', label: '工具开关' },
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

onMounted(() => {
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data
    if (!m) return
    if (m.type === 'config') { cfg.value = m.data; return }
    if (m.type === 'configSaved') { flashSaved(); return }
    const w = m.seq ? waiters.get(m.seq) : undefined
    if (!w) return
    waiters.delete(m.seq)
    if (m.error) w.reject(m.error)
    else if (m.type === 'skills') w.resolve(m.items || [])
    else if (m.type === 'skillContent') w.resolve(m.content || '')
    else w.resolve(true)
  })
  void call('getConfig').catch(() => undefined)
  void loadSkills()
})

// ---- 技能（真实 .md 文件）----
interface SkillItem { name: string; title: string; preview: string }
const skills = ref<SkillItem[]>([])
const editingName = ref('')
const editingContent = ref('')
const skillDirty = ref(false)
const skillError = ref('')
const showCreate = ref(false)
const newSkillName = ref('')

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
            <input :value="cfg.baseUrl" spellcheck="false"
              @change="(e) => patch({ baseUrl: (e.target as HTMLInputElement).value.trim() })" />
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
        </div>
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
        <p class="sec-sub">技能是保存在本机的提示词模板；在输入框键入「/」可快速插入</p>
        <div class="skill-wrap">
          <div class="skill-list">
            <button type="button" class="skill-add" @click="showCreate = true">＋ 新建技能</button>
            <button
              v-for="item in skills" :key="item.name" type="button"
              class="skill-item" :class="{ on: editingName === item.name }"
              @click="openSkill(item)"
            >
              <div class="skill-name">{{ item.title }}</div>
              <div class="skill-preview">{{ item.preview || '（空）' }}</div>
            </button>
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
            <div v-else class="skill-empty">从左侧选择一个技能，或新建技能</div>
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
