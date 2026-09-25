// 配置：非敏感项走 vscode workspace 配置；API Key 走 SecretStorage 加密

import * as vscode from 'vscode'
import type { LLMConfig } from './llm.js'

export const PROVIDER_PRESETS: Record<string, { url: string; model: string; label: string }> = {
  doubao: { label: '豆包 (火山引擎)', url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
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

export function setConfig(patch: Partial<{ provider: string; baseUrl: string; model: string; supportsTools: string; autoApprove: boolean }>): Thenable<void> {
  const c = cfg()
  const strTargets: Array<[string, string]> = []
  const boolTargets: Array<[string, boolean]> = []
  if (patch.provider !== undefined) strTargets.push(['provider', patch.provider])
  if (patch.baseUrl !== undefined) strTargets.push(['baseUrl', patch.baseUrl])
  if (patch.model !== undefined) strTargets.push(['model', patch.model])
  if (patch.supportsTools !== undefined) strTargets.push(['supportsTools', patch.supportsTools])
  if (patch.autoApprove !== undefined) boolTargets.push(['autoApprove', patch.autoApprove])
  return Promise.all([
    ...strTargets.map(([k, v]) => c.update(k, v, vscode.ConfigurationTarget.Global)),
    ...boolTargets.map(([k, v]) => c.update(k, v, vscode.ConfigurationTarget.Global)),
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
