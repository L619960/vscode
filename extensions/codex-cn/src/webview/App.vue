<script setup lang="ts">
// Webview 根组件：对话 / 设置 两个标签
import { ref, onMounted } from 'vue'
import { vscodeApi } from './main'
import ChatView from './components/ChatView.vue'
import SettingsView from './components/SettingsView.vue'

const tab = ref<'chat' | 'settings'>('chat')

onMounted(() => {
  vscodeApi.postMessage({ type: 'ready' })
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.data?.type === 'openSettings') tab.value = 'settings'
  })
})
</script>

<template>
  <div class="app">
    <div class="tabs">
      <button class="tab-btn" :class="{ active: tab === 'chat' }" @click="tab = 'chat'">对话</button>
      <button class="tab-btn" :class="{ active: tab === 'settings' }" @click="tab = 'settings'">设置</button>
    </div>
    <ChatView v-show="tab === 'chat'" />
    <SettingsView v-if="tab === 'settings'" @done="tab = 'chat'" />
  </div>
</template>
