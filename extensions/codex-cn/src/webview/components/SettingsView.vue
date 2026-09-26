<script setup lang="ts">
// 模型接入设置视图
import { ref, onMounted } from 'vue'
import { vscodeApi } from '../main'

const emit = defineEmits(['done'])

const provider = ref('doubao')
const baseUrl = ref('')
const modelName = ref('')
const supportsTools = ref('auto')
const autoApprove = ref(false)
const tabCompletion = ref(true)
const apiKey = ref('')
const hasKey = ref(false)
const presets = ref<Record<string, string>>({})
const saved = ref(false)

onMounted(() => {
  const handler = (e: MessageEvent) => {
    if (e.data?.type === 'config') {
      const d = e.data.data
      provider.value = d.provider
      baseUrl.value = d.baseUrl
      modelName.value = d.model
      supportsTools.value = d.supportsTools
      autoApprove.value = !!d.autoApprove
      tabCompletion.value = d.tabCompletion !== false
      hasKey.value = d.hasKey
      presets.value = d.presets
    } else if (e.data?.type === 'configSaved') {
      saved.value = true
      setTimeout(() => { saved.value = false; emit('done') }, 900)
    }
  }
  window.addEventListener('message', handler)
  vscodeApi.postMessage({ type: 'getConfig' })
})

function save(): void {
  vscodeApi.postMessage({
    type: 'saveConfig',
    patch: {
      provider: provider.value, baseUrl: baseUrl.value.trim(),
      model: modelName.value.trim(), supportsTools: supportsTools.value,
      autoApprove: autoApprove.value, tabCompletion: tabCompletion.value,
      ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
    },
  })
  apiKey.value = ''
}
</script>

<template>
  <div class="settings-view">
    <div class="field">
      <label>模型提供商</label>
      <select v-model="provider">
        <option v-for="(label, key) in presets" :key="key" :value="key">{{ label }}</option>
      </select>
    </div>
    <div class="field">
      <label>API 地址</label>
      <input v-model="baseUrl" spellcheck="false" placeholder="https://..." />
    </div>
    <div class="field">
      <label>API Key</label>
      <input v-model="apiKey" type="password" spellcheck="false"
        :placeholder="hasKey ? '已配置，留空则不修改' : 'sk-...'" />
      <span class="hint">由 VS Code SecretStorage 加密存储</span>
    </div>
    <div class="field">
      <label>模型名称</label>
      <input v-model="modelName" spellcheck="false" placeholder="模型名" />
    </div>
    <div class="field">
      <label>工具调用</label>
      <select v-model="supportsTools">
        <option value="auto">自动检测</option>
        <option value="yes">强制启用</option>
        <option value="no">关闭（纯对话）</option>
      </select>
    </div>
    <div class="field">
      <label class="check-row">
        <input type="checkbox" v-model="tabCompletion" />
        <span>Tab 代码补全（编辑器内 AI 行内补全）</span>
      </label>
      <span class="hint">开启后在编辑器中按 Tab 接受 AI 补全建议</span>
    </div>
    <div class="field">
      <label class="check-row">
        <input type="checkbox" v-model="autoApprove" />
        <span>自动审批（AI 自主执行写文件/命令，不再询问）</span>
      </label>
      <span class="hint">开启后 AI 可直接改文件、跑命令，请谨慎使用</span>
    </div>
    <button class="btn primary block" @click="save">{{ saved ? '✓ 已保存' : '保存配置' }}</button>
  </div>
</template>
