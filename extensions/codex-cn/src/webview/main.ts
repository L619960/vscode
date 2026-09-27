// Webview 启动入口
import { createApp } from 'vue'
import { Collapse, CollapseItem, Popup } from 'vant'
import 'vant/es/collapse/style/index.mjs'
import 'vant/es/collapse-item/style/index.mjs'
import 'vant/es/popup/style/index.mjs'
import App from './App.vue'
import SettingsPage from './components/SettingsPage.vue'
import './styles.css'

// vscode webview API 获取（带 acquireVsCodeApi 兜底类型）
declare function acquireVsCodeApi(): any
export const vscodeApi = acquireVsCodeApi()

// 宿主在容器上通过 data-view 声明视图：chat/agent=聊天，settings=设置标签页
const root = document.getElementById('app')!
const view = root.dataset.view === 'settings' ? 'settings' : 'chat'
const page = view === 'settings' ? SettingsPage : App

createApp(page).use(Collapse).use(CollapseItem).use(Popup).mount(root)
