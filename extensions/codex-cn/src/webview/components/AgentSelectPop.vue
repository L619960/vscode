<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { vscodeApi } from '../main'

const emit = defineEmits<{ (e: 'change', mode: 'chat' | 'agent'): void }>()

const showPop = ref(false)
const selected = ref<'chat' | 'agent'>('agent')

// 与后端 supportsTools 配置同步（no → Chat 纯对话，其余 → Agent）
onMounted(() => {
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data
    if (m.type === 'config') {
      const v = m.data?.supportsTools === 'no' ? 'chat' : 'agent'
      if (v !== selected.value) { selected.value = v; emit('change', v) }
    }
  })
  vscodeApi.postMessage({ type: 'getConfig' })
})

const list = ref([
  { value: 'chat' as const, icon: '💬', name: 'Chat', desc: '纯对话，不调用工具' },
  { value: 'agent' as const, icon: '🤖', name: 'Agent', desc: '可读写文件、运行命令' },
])

function onSelect(item: typeof list.value[0]): void {
  selected.value = item.value
  showPop.value = false
  emit('change', item.value)
  vscodeApi.postMessage({ type: 'setAgentMode', mode: item.value })
}
</script>

<template>
  <div class="agent-mode-wrap">
    <button class="text-btn" title="选择 Agent 类型" @click="showPop = true">
      <span class="at-sign">@</span>
      <span class="at-name">{{ selected === 'agent' ? 'Agent' : 'Chat' }}</span>
      <svg class="chev" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
    </button>

    <van-popup
      v-model:show="showPop"
      position="bottom"
      :style="{ maxWidth: '280px', margin: '0 auto', borderRadius: '8px' }"
      close-on-click-overlay
      class="pop-dark"
    >
      <div class="pop-header">
        <span class="pop-title">Built-In Agents</span>
      </div>
      <div class="pop-list">
        <div
          v-for="item in list" :key="item.value"
          class="pop-item"
          :class="{ active: selected === item.value }"
          @click="onSelect(item)"
        >
          <span class="pop-icon">{{ item.icon }}</span>
          <div class="pop-text">
            <div class="pop-item-title">{{ item.name }}</div>
            <div class="pop-item-desc">{{ item.desc }}</div>
          </div>
          <span v-if="selected === item.value" class="pop-check">✓</span>
        </div>
      </div>
    </van-popup>
  </div>
</template>
