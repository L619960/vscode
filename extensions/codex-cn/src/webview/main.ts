// Webview 启动入口
import { createApp } from 'vue'
import { Collapse, CollapseItem, Popup } from 'vant'
import 'vant/es/collapse/style/index.mjs'
import 'vant/es/collapse-item/style/index.mjs'
import 'vant/es/popup/style/index.mjs'
import App from './App.vue'
import './styles.css'

// vscode webview API 获取（带 acquireVsCodeApi 兜底类型）
declare function acquireVsCodeApi(): any
export const vscodeApi = acquireVsCodeApi()

createApp(App).use(Collapse).use(CollapseItem).use(Popup).mount('#app')
