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
    <button class="icon-btn" :title="list.find(i => i.value === selected)?.title || '审批模式'" @click="showPop = true">
      <!-- 完全访问：绿色解锁盾牌；其余：橙色盾牌+感叹号（对齐参考图） -->
      <svg v-if="selected === 'full'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.8" stroke-linejoin="round">
        <path d="M12 2L4 5v6c0 5 3.4 9.2 8 11 4.6-1.8 8-6 8-11V5l-8-3z"/>
        <path d="M9 12l2.2 2.2L16 9.5" stroke-linecap="round"/>
      </svg>
      <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8912d" stroke-width="1.8" stroke-linejoin="round">
        <path d="M12 2L4 5v6c0 5 3.4 9.2 8 11 4.6-1.8 8-6 8-11V5l-8-3z"/>
        <path d="M12 8.2v4.4" stroke-linecap="round"/>
        <circle cx="12" cy="15.6" r="0.6" fill="#e8912d" stroke="none"/>
      </svg>
      <svg class="chev" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
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
