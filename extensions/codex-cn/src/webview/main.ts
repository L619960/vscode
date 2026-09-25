// Webview 启动入口
import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

// vscode webview API 获取（带 acquireVsCodeApi 兜底类型）
declare function acquireVsCodeApi(): any
export const vscodeApi = acquireVsCodeApi()

createApp(App).mount('#app')
