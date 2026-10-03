# 技能关联功能升级计划

## 背景与需求

当前技能系统全局共享（`globalStorage/skills/*.md`），所有项目使用同一套技能。用户需要：
1. 在设置页面批量勾选技能进行关联/取消关联
2. 显示技能已关联到当前项目的状态
3. 支持搜索和筛选技能
4. Agent 只加载与当前项目关联的技能

## 技术方案

### 数据层：项目级技能关联配置

**存储位置**：`.agent/linked-skills.json`（项目工作区内）

**格式**：
```json
{
  "version": 1,
  "linked": ["代码审查.md", "Python 脚本.md"],
  "updatedAt": "2026-09-28T19:00:00Z"
}
```

**SkillsStore 扩展**：
- `listWithStatus(workspaceRoot)` - 返回技能列表 + 关联状态
- `linkSkills(workspaceRoot, names[])` - 批量关联
- `unlinkSkills(workspaceRoot, names[])` - 批量取消关联  
- `getLinkedSkills(workspaceRoot)` - 获取当前项目关联的技能列表
- `ensureProjectConfig(workspaceRoot)` - 确保 `.agent/` 目录和配置文件存在

### UI 层：设置页面升级

**SettingsPage.vue 技能管理区**：

1. **搜索筛选**：
   - 顶部搜索框，按技能名称/标题/内容实时过滤
   - 筛选选项：全部 / 已关联 / 未关联

2. **批量操作工具栏**：
   - 全选 / 取消全选
   - 批量关联 / 批量取消关联
   - 已选计数显示

3. **技能列表项**：
   - 复选框（关联状态）
   - 技能名称和预览
   - "已关联"状态标记（绿色标签）
   - 点击名称仍打开编辑器

4. **状态反馈**：
   - 操作成功/失败 toast 提示
   - 批量操作进度显示
   - 关联状态变更即时保存

### Agent 集成

**runAgent.ts 修改**：
- `buildSkillIndex()` 改为 `buildSkillIndex(skills, workspaceRoot)`
- 只列出与当前项目关联的技能
- 若无关联技能，回退到列出全部技能（避免 Agent 无技能可用）

**prompt.ts 修改**：
- 技能索引段添加说明：仅显示已关联到当前项目的技能

## 关键文件修改

1. `src/skills.ts` - 添加项目关联管理方法
2. `src/webview/components/SettingsPage.vue` - 技能管理 UI 全面升级
3. `src/runAgent.ts` - buildSkillIndex 支持项目过滤
4. `src/prompt.ts` - 技能索引说明更新
5. `src/extension.ts` - 消息处理添加 linkSkills/unlinkSkills/listWithStatus

## 兼容性保证

- 无 `.agent/linked-skills.json` 时默认全部技能关联（向后兼容）
- 配置文件损坏时自动重置为默认状态
- 现有聊天 `/` 插入功能不受影响
- 全局技能文件保持不变，仅添加项目级关联配置

## 验证方案

1. 设置页面批量勾选/取消勾选技能，验证 `.agent/linked-skills.json` 正确更新
2. 搜索筛选功能正常工作
3. Agent 对话中 `/` 只显示已关联技能
4. 删除 `.agent/linked-skills.json` 后回退到全部技能
5. 多项目切换时关联状态独立
