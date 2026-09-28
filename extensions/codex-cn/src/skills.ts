// 技能库：globalStorage/skills/*.md 真实文件管理
// 输入框 "/" 触发插入；设置页对文件做真实增删改。

import * as vscode from 'vscode'

/** 技能元信息（列表用） */
export interface SkillMeta {
  /** 文件名（含 .md） */
  name: string
  /** 标题：取首个 # 标题，否则用文件名 */
  title: string
  /** 正文前 120 字纯文本预览 */
  preview: string
  /** 完整内容（供输入框「/」直接插入） */
  content: string
}

/** Vendored 技能（Superpowers 等内置框架）列表项 */
export interface VendorSkillMeta {
  /** 技能目录名（load_skill 的 name 参数） */
  name: string
  /** frontmatter 中的名称 */
  title: string
  /** frontmatter 描述（一句话，用于技能索引） */
  description: string
}

/** 单个技能文件大小上限（字符），防止误贴巨型内容 */
const MAX_SKILL_CHARS = 8000

/**
 * 安全文件名校验：仅允许中英文/数字/空格/短横，必须 .md 结尾。
 * 拒绝路径分隔符与 ..，防止路径逃逸。
 */
export function safeSkillName(name: string): boolean {
  return /^[\w一-龥][\w一-龥\- ]{0,40}\.md$/.test(name)
}

/** 解析 Markdown frontmatter（--- 包裹的简单 key: value，值去首尾引号） */
function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** 内置技能：首次启动写入真实文件 */
const BUILTIN: Array<{ name: string; content: string }> = [
  {
    name: '代码审查.md',
    content: `# 代码审查
请对我指定的代码做一次严格审查：
1. 正确性：逻辑错误、边界条件、空值与异常处理；
2. 安全性：注入、路径逃逸、敏感信息泄露；
3. 可维护性：命名、重复代码、函数复杂度；
4. 性能：明显的性能陷阱。
按「严重程度」分组列出问题，每条给出文件位置、原因和修改建议，最后给出总体结论。`,
  },
  {
    name: 'Python 脚本.md',
    content: `# Python 脚本
请帮我编写一个 Python 脚本，要求：
1. 明确输入与输出；
2. 必要的异常处理与中文注释；
3. 入口使用 if __name__ == '__main__'；
4. 写完后实际运行验证，并说明运行方式与依赖。`,
  },
  {
    name: '前端组件.md',
    content: `# 前端组件
请帮我实现一个前端组件，要求：
1. 说明使用的框架与组件划分；
2. 清晰的 props / 事件定义；
3. 基本的响应式与无障碍处理；
4. 附上使用示例。`,
  },
]

export class SkillsStore {
  private readonly dirUri: vscode.Uri
  /** 内置 vendored 技能根目录（如扩展内 vendor/superpowers/skills）；无则不支持 vendor 技能 */
  private readonly vendorRoot?: vscode.Uri

  constructor(globalStorageUri: vscode.Uri, vendorRoot?: vscode.Uri) {
    this.dirUri = vscode.Uri.joinPath(globalStorageUri, 'skills')
    this.vendorRoot = vendorRoot
  }

  /** 确保目录存在；目录为空时写入内置技能（幂等） */
  async ensure(): Promise<void> {
    try {
      await vscode.workspace.fs.readDirectory(this.dirUri)
    } catch {
      await vscode.workspace.fs.createDirectory(this.dirUri)
    }
    let entries: [string, vscode.FileType][]
    try { entries = await vscode.workspace.fs.readDirectory(this.dirUri) } catch { return }
    const mdFiles = entries.filter(([n, t]) => t === vscode.FileType.File && n.endsWith('.md'))
    if (mdFiles.length) return
    for (const item of BUILTIN) {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(this.dirUri, item.name),
        new TextEncoder().encode(item.content),
      )
    }
  }

  /** 列出全部技能（按文件名排序） */
  async list(): Promise<SkillMeta[]> {
    await this.ensure()
    const entries = await vscode.workspace.fs.readDirectory(this.dirUri)
    const metas: SkillMeta[] = []
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.md')) continue
      const text = await this.read(name)
      const titleMatch = /^#\s+(.+)$/m.exec(text)
      const plain = text.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim()
      metas.push({
        name,
        title: titleMatch?.[1].trim() || name.replace(/\.md$/, ''),
        preview: plain.slice(0, 120),
        content: text,
      })
    }
    return metas.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  /** 读取完整内容（文件不存在抛错） */
  async read(name: string): Promise<string> {
    if (!safeSkillName(name)) throw new Error('非法技能文件名')
    const buf = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dirUri, name))
    return new TextDecoder('utf-8').decode(buf)
  }

  /** 新建：写入标准模板；同名文件拒绝覆盖 */
  async create(name: string): Promise<void> {
    if (!safeSkillName(name)) throw new Error('文件名仅支持中英文、数字、空格、短横，且以 .md 结尾')
    const uri = vscode.Uri.joinPath(this.dirUri, name)
    try {
      await vscode.workspace.fs.stat(uri)
      throw new Error('同名技能已存在')
    } catch (e) {
      if ((e as Error).message === '同名技能已存在') throw e
    }
    const title = name.replace(/\.md$/, '')
    const tpl = `# ${title}\n\n请在此编写提示词内容……\n`
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(tpl))
  }

  /** 保存内容（真实写盘，超长拒绝） */
  async save(name: string, content: string): Promise<void> {
    if (!safeSkillName(name)) throw new Error('非法技能文件名')
    const text = String(content ?? '')
    if (text.length > MAX_SKILL_CHARS) {
      throw new Error(`技能内容不能超过 ${MAX_SKILL_CHARS} 字符（当前 ${text.length}）`)
    }
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.dirUri, name),
      new TextEncoder().encode(text),
    )
  }

  /** 删除文件 */
  async remove(name: string): Promise<void> {
    if (!safeSkillName(name)) throw new Error('非法技能文件名')
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dirUri, name))
  }

  // ---- 项目级技能关联：.agent/linked-skills.json ----

  /** 项目关联配置文件路径 */
  private getProjectConfigUri(workspaceRoot: string): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), '.agent', 'linked-skills.json')
  }

  /** 确保项目配置目录存在 */
  private async ensureProjectConfig(workspaceRoot: string): Promise<void> {
    const agentDir = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), '.agent')
    try {
      await vscode.workspace.fs.createDirectory(agentDir)
    } catch { /* 已存在 */ }
  }

  /** 读取项目关联的技能列表 */
  async getLinkedSkills(workspaceRoot: string): Promise<string[]> {
    try {
      const uri = this.getProjectConfigUri(workspaceRoot)
      const buf = await vscode.workspace.fs.readFile(uri)
      const data = JSON.parse(Buffer.from(buf).toString('utf-8'))
      return Array.isArray(data.linked) ? data.linked : []
    } catch {
      return []
    }
  }

  /** 批量关联技能到项目 */
  async linkSkills(workspaceRoot: string, names: string[]): Promise<void> {
    await this.ensureProjectConfig(workspaceRoot)
    const linked = await this.getLinkedSkills(workspaceRoot)
    const newLinked = [...new Set([...linked, ...names])]
    await this.writeProjectConfig(workspaceRoot, newLinked)
  }

  /** 批量取消技能关联 */
  async unlinkSkills(workspaceRoot: string, names: string[]): Promise<void> {
    await this.ensureProjectConfig(workspaceRoot)
    const linked = await this.getLinkedSkills(workspaceRoot)
    const newLinked = linked.filter(n => !names.includes(n))
    await this.writeProjectConfig(workspaceRoot, newLinked)
  }

  /** 写入项目关联配置 */
  private async writeProjectConfig(workspaceRoot: string, linked: string[]): Promise<void> {
    const uri = this.getProjectConfigUri(workspaceRoot)
    const data = {
      version: 1,
      linked,
      updatedAt: new Date().toISOString(),
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(data, null, 2)))
  }

  /** 列出技能并附带项目关联状态 */
  async listWithStatus(workspaceRoot: string): Promise<Array<SkillMeta & { linked: boolean }>> {
    const [all, linked] = await Promise.all([
      this.list(),
      this.getLinkedSkills(workspaceRoot),
    ])
    return all.map(skill => ({
      ...skill,
      linked: linked.includes(skill.name),
    }))
  }

  // ---- Vendored 技能（内置 Superpowers 框架；只读，不允许用户增删改）----

  /** 列出 vendored 技能（按目录名排序） */
  async listVendor(): Promise<VendorSkillMeta[]> {
    if (!this.vendorRoot) return []
    let entries: [string, vscode.FileType][]
    try { entries = await vscode.workspace.fs.readDirectory(this.vendorRoot) } catch { return [] }
    const metas: VendorSkillMeta[] = []
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) continue
      let text = ''
      try { text = await this.readVendor(name) } catch { continue }
      const fm = parseFrontmatter(text)
      metas.push({
        name,
        title: fm.name || name,
        description: (fm.description || '').slice(0, 100),
      })
    }
    return metas.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 读取 vendored 技能文件：默认 SKILL.md；file 参数可读 references 等附属文件。
   * 路径限定在该技能目录内，禁止 .. 逃逸。
   */
  async readVendor(name: string, file?: string): Promise<string> {
    if (!this.vendorRoot) throw new Error('无内置技能目录')
    if (!/^[\w-]{1,40}$/.test(name)) throw new Error('非法技能名')
    const relFile = file ? String(file).replace(/^[/\\]+/, '') : 'SKILL.md'
    if (relFile.includes('..')) throw new Error('非法文件路径')
    const segments = relFile.split(/[/\\]/).filter(Boolean)
    const uri = vscode.Uri.joinPath(this.vendorRoot, name, ...segments)
    try {
      const buf = await vscode.workspace.fs.readFile(uri)
      return new TextDecoder('utf-8').decode(buf)
    } catch {
      throw new Error(`技能文件不存在：${name}/${relFile}`)
    }
  }
}
