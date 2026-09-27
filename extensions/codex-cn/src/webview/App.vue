<script setup lang="ts">
// Webview 根组件：直接渲染对话视图（设置改为弹层，不再用标签页）
import { onMounted } from 'vue'
import { vscodeApi } from './main'
import ChatView from './components/ChatView.vue'

onMounted(() => {
  vscodeApi.postMessage({ type: 'ready' })
})
</script>

<template>
  <div class="app">
    <ChatView />
  </div>
</template>
