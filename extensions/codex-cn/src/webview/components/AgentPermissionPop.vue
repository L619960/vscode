<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { vscodeApi } from '../main'

const showPop = ref(false)
const selected = ref<'manual' | 'auto' | 'full' | 'custom'>('auto')

// 与后端 autoApprove 配置同步（true → 完全访问，false → 自动审批）
onMounted(() => {
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data
    if (m.type === 'config') selected.value = m.data?.autoApprove ? 'full' : 'auto'
  })
  vscodeApi.postMessage({ type: 'getConfig' })
})

const list = ref([
  { value: 'manual' as const, icon: '🛡️', title: '手动审批', desc: '重要操作由你确认' },
  { value: 'auto' as const, icon: '🤖', title: '自动审批', desc: '由 AI 审核，必要时再询问你' },
  { value: 'full' as const, icon: '🔓', title: '完全访问', desc: '不经审批，直接在本机运行' },
  { value: 'custom' as const, icon: '⚙️', title: '自定义', desc: '通过配置文件设置规则' },
])

function onSelect(item: typeof list.value[0]): void {
  selected.value = item.value
  showPop.value = false
  vscodeApi.postMessage({ type: 'saveConfig', patch: { autoApprove: item.value === 'full' } })
}
</script>

<template>
  <div class="permission-wrap">
    <button class="mini-btn" @click="showPop = true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L3 7v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5z"/></svg>
      <span>{{ list.find(i => i.value === selected)?.title || '审批' }}</span>
      <svg class="arrow" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
    </button>

    <van-popup
      v-model:show="showPop"
      position="bottom"
      :style="{ maxWidth: '340px', margin: '0 auto', borderRadius: '8px' }"
      close-on-click-overlay
      class="pop-dark"
    >
      <div class="pop-header">
        <span class="pop-title">如何批准 Agent 的操作？</span>
        <a class="pop-link" @click="showPop = false; vscodeApi.postMessage({ type: 'openSettings' })">了解更多</a>
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
            <div class="pop-item-title">{{ item.title }}</div>
            <div class="pop-item-desc">{{ item.desc }}</div>
          </div>
          <span v-if="selected === item.value" class="pop-check">✓</span>
        </div>
      </div>
    </van-popup>
  </div>
</template>
