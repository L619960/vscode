// 配置：非敏感项走 vscode workspace 配置；API Key 走 SecretStorage 加密

import * as vscode from 'vscode'
import type { LLMConfig } from './llm.js'

export const PROVIDER_PRESETS: Record<string, { url: string; model: string; label: string }> = {
  doubao: { label: '豆包 (火山引擎)', url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
  volcesPlan: { label: '火山引擎 Coding Plan', url: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: 'ark-code-latest' },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { label: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  kimi: { label: 'Kimi (月之暗面)', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { label: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  openai: { label: 'OpenAI 官方', url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  llama: { label: 'llama.cpp 本地', url: 'http://127.0.0.1:8080/v1', model: 'local-model' },
  ollama: { label: 'Ollama 本地', url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
  custom: { label: '自定义', url: '', model: '' },
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('codex-cn')
}

export function getLLMConfig(apiKey: string): LLMConfig {
  const c = cfg()
  const supportsRaw = c.get<string>('supportsTools', 'auto')
  return {
    baseUrl: c.get<string>('baseUrl', ''),
    model: c.get<string>('model', ''),
    supportsTools: supportsRaw === 'yes' ? true : supportsRaw === 'no' ? false : null,
    apiKey,
  }
}

export function getProvider(): string {
  return cfg().get<string>('provider', 'doubao')
}

export async function applyProviderPreset(provider: string): Promise<void> {
  const preset = PROVIDER_PRESETS[provider]
  if (!preset || provider === 'custom') return
  const c = cfg()
  await c.update('baseUrl', preset.url, vscode.ConfigurationTarget.Global)
  await c.update('model', preset.model, vscode.ConfigurationTarget.Global)
}

export function setConfig(patch: Partial<{
  provider: string
  baseUrl: string
  model: string
  supportsTools: string
  autoApprove: boolean
  planMode: boolean
  superpowers: boolean
  tabCompletion: boolean
  toolRead: boolean
  toolWrite: boolean
  toolShell: boolean
  toolBrowser: boolean
  toolWeb: boolean
  privacyMode: boolean
  maxMessages: number
  autoTitle: boolean
  maxSessions: number
}>): Thenable<void> {
  const c = cfg()
  const strTargets: Array<[string, string]> = []
  const boolTargets: Array<[string, boolean]> = []
  const numTargets: Array<[string, number]> = []
  if (patch.provider !== undefined) strTargets.push(['provider', patch.provider])
  if (patch.baseUrl !== undefined) strTargets.push(['baseUrl', patch.baseUrl])
  if (patch.model !== undefined) strTargets.push(['model', patch.model])
  if (patch.supportsTools !== undefined) strTargets.push(['supportsTools', patch.supportsTools])
  if (patch.autoApprove !== undefined) boolTargets.push(['autoApprove', patch.autoApprove])
  if (patch.planMode !== undefined) boolTargets.push(['planMode', patch.planMode])
  if (patch.superpowers !== undefined) boolTargets.push(['superpowers', patch.superpowers])
  if (patch.tabCompletion !== undefined) boolTargets.push(['tabCompletion', patch.tabCompletion])
  if (patch.toolRead !== undefined) boolTargets.push(['toolRead', patch.toolRead])
  if (patch.toolWrite !== undefined) boolTargets.push(['toolWrite', patch.toolWrite])
  if (patch.toolShell !== undefined) boolTargets.push(['toolShell', patch.toolShell])
  if (patch.toolBrowser !== undefined) boolTargets.push(['toolBrowser', patch.toolBrowser])
  if (patch.toolWeb !== undefined) boolTargets.push(['toolWeb', patch.toolWeb])
  if (patch.privacyMode !== undefined) boolTargets.push(['privacyMode', patch.privacyMode])
  if (patch.autoTitle !== undefined) boolTargets.push(['autoTitle', patch.autoTitle])
  if (patch.maxMessages !== undefined) numTargets.push(['maxMessages', patch.maxMessages])
  if (patch.maxSessions !== undefined) numTargets.push(['maxSessions', patch.maxSessions])
  return Promise.all([
    ...strTargets.map(([k, v]) => c.update(k, v, vscode.ConfigurationTarget.Global)),
    ...boolTargets.map(([k, v]) => c.update(k, v, vscode.ConfigurationTarget.Global)),
    ...numTargets.map(([k, v]) => c.update(k, v, vscode.ConfigurationTarget.Global)),
  ]).then(() => undefined)
}

/** API Key 存入 SecretStorage（VS Code 加密落盘） */
export async function saveApiKey(secrets: vscode.SecretStorage, key: string): Promise<void> {
  if (!key) return
  await secrets.store('codex-cn.apiKey', key)
}

export async function getApiKey(secrets: vscode.SecretStorage): Promise<string> {
  return (await secrets.get('codex-cn.apiKey')) ?? ''
}

// ---- Agent 运行策略（工具开关 / 隐私 / 对话流）----
/** 工具分组 → 配置键 */
export interface AgentSettings {
  /** 文件读取类（read_file/list_dir/search_files/glob/read_lints） */
  toolRead: boolean
  /** 文件写入类（write_file/edit_file） */
  toolWrite: boolean
  /** 命令执行类（run_command/await_shell start） */
  toolShell: boolean
  /** 浏览器类（browser_*） */
  toolBrowser: boolean
  /** 联网类（web_search/web_fetch） */
  toolWeb: boolean
  /** 隐私模式：阻止联网外发 */
  privacyMode: boolean
  /** 单会话消息保留条数 */
  maxMessages: number
  /** 首条消息自动生成会话标题 */
  autoTitle: boolean
  /** 历史会话保留上限 */
  maxSessions: number
}

/** 统一读取 Agent 运行策略（拦截点实时读取，保证设置即时生效） */
export function getAgentSettings(): AgentSettings {
  const c = cfg()
  return {
    toolRead: c.get<boolean>('toolRead', true),
    toolWrite: c.get<boolean>('toolWrite', true),
    toolShell: c.get<boolean>('toolShell', true),
    toolBrowser: c.get<boolean>('toolBrowser', true),
    toolWeb: c.get<boolean>('toolWeb', true),
    privacyMode: c.get<boolean>('privacyMode', false),
    maxMessages: c.get<number>('maxMessages', 100),
    autoTitle: c.get<boolean>('autoTitle', true),
    maxSessions: c.get<number>('maxSessions', 60),
  }
}
