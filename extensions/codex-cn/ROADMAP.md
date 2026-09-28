# Codex CN 能力现状与迭代对标方案

> 用途：跨会话备忘。新窗口开始工作前先读本文，避免重复盘点。
> 最后更新：2026-09-28 ｜ 分支：`codex-cn/custom` ｜ 远端：`fork` → https://github.com/L619960/vscode
> 源码：`D:\codex-cn-oss\extensions\codex-cn\` ｜ 运行时：`D:\VSCode-win32-x64\`

---

## 一、当前已具备的能力（现状全景）

### 1. Agent 核心循环（`runAgent.ts`）
- 流式 Chat Completion + 工具调用循环（流式 tool_calls 按 index 累积）
- **流程闸门**：未调用 `todo_write` 就执行写文件/命令 → 拦截并回喂
- 工具 400 错误自动降级（兼容不支持 function calling 的模型）
- LLM 500/网络错误：错误信息回喂重试，最多 3 次
- 参数 JSON 容错：非法 JSON 不执行，回喂修正
- 空响应：撤空气泡 + 催办，连续 3 次才停
- 上下文超限裁剪最旧消息；支持中断（停止按钮）

### 2. 工具清单：共 35 个（`tools.ts` 统一定义 schema）
| 分组 | 工具 |
|------|------|
| 文件（9） | `list_dir` `read_file` `write_file` `edit_file` `delete_file` `edit_notebook` `glob` `search_files` `read_lints` |
| 终端（2） | `run_command`（30s 前台）`await_shell`（后台 start/logs/wait/stop/list） |
| 网络（2） | `web_search` `web_fetch` |
| 浏览器（18） | navigate / snapshot / click / type / press_key / fill / select_option / scroll / screenshot / tabs / eval / **cdp（任意 CDP 命令）/ mouse_click_xy / get_bounding_box / drag / highlight / lock / unlock** |
| 规划（1） | `todo_write`（P0/P1 + 证据 + 持久化，对接规划卡） |
| 交互（1） | `ask_user`（结构化提问，永不被自动审批跳过） |
| 子代理（2） | `spawn_task` `await_task`（独立上下文、工具白名单、并行上限 2、免审批） |

### 3. 编辑器能力
- **Tab 补全**（`tabCompletion.ts`）：InlineCompletionItemProvider，提示词式 FIM（前 20 行/后 10 行），防抖 300ms，128 tokens
- **Ctrl+K 行内编辑**（`inlineEdit.ts`）：选中代码 + 指令 → 改写 → 应用/放弃/查看 Diff

### 4. UI / 会话（Vue3 + Vant4，三宿主复用同一 dist/webview.js）
- 双入口：右侧辅助栏 Chat 视图 + 编辑器 Agent 标签页（多开/分屏）
- 多会话：上限 60、消息上限 100、自动标题、持久化 `codex-cn.sessions.v2`
- 设置中心（编辑器标签页）：模型/工具开关/隐私/对话流/技能，无假按钮
- 任务规划板集成到 Agent 消息头（折叠条目 + 状态栏）
- 审批卡片：允许/拒绝/总是允许/查看 Diff（vscode.diff），hover 反馈
- 时间线样式（有工具）/气泡样式（纯聊天）；同名工具聚合计数；思考默认折叠
- 消息操作：复制 / 删除 / 回退 / 修改
- 技能库：`globalStorage/skills/*.md` 真实文件，输入框 `/` 触发插入
- 提示词优化 ✨（调用当前模型改写后回填）

### 5. 安全与配置
- API Key 走 `SecretStorage`（VS Code 加密落盘），禁止明文 localStorage
- 配置统一 IPC 管理；9 家提供商预设（豆包/DeepSeek/通义/Kimi/智谱/OpenAI/llama.cpp/Ollama/自定义）
- 路径防逃逸（写盘二次校验在工作区内）
- 工具开关（读/写/Shell/浏览器/网络）+ 隐私模式（拦截联网）
- 危险命令（rm -rf / del /s / shutdown 等）即使自动审批也强制弹窗
- 快照回滚：写操作前自动保存（上限 100），QuickPick 恢复

---

## 二、对标产品矩阵

对标对象：**Cursor**（主要）、**Trae**、**Cline / Roo Code**、**GitHub Copilot**、**Windsurf**。

| 能力维度 | Codex CN 现状 | Cursor | Trae | Cline/Roo | Copilot |
|---|---|---|---|---|---|
| Agent 工具循环 | ✅ 35 工具 | ✅ | ✅ | ✅ | ✅ Agent Mode |
| 子代理/委派 | ✅ 基础（无 UI） | ✅ Background Agents | ✅ SOLO | ✅ Roo Orchestrator | ❌ |
| 代码库语义索引 | ❌ 仅关键词搜索 | ✅ Codebase Index | ✅ | ❌（靠搜索） | ✅ |
| @/# 上下文引用 | ⚠️ 仅 @文件/文件夹 | ✅ @文件/符号/docs/codebase/git/web | ✅ #上下文 | ⚠️ | ✅ #codebase |
| MCP 生态 | ❌ | ✅ | ✅ | ✅ | ⚠️ |
| 多模态（图片输入） | ❌（本地小模型无视觉） | ✅ | ✅ | ✅ | ✅ |
| 图像生成 | ❌ | ⚠️ 插件 | ❌ | ❌ | ❌ |
| Checkpoint 可视化 | ⚠️ 有快照无 diff UI | ❌（云保存） | ❌ | ✅ 快照树+逐文件 diff | ❌ |
| 上下文智能压缩 | ❌ 硬裁剪 | ✅ | ✅ | ✅ | ✅ |
| Tab 补全质量 | ⚠️ 提示词 FIM 单行 | ✅ 多行/多光标/agentic | ⚠️ | ❌ | ✅ |
| 规则系统 | ⚠️ AGENT_RULES.md | ✅ Rules/自定义模式 | ✅ 规则 | ✅ 自定义模式 | ⚠️ instructions |
| Git/PR 工作流 | ❌ 走 shell | ✅ Bug Bot/PR Review | ⚠️ | ⚠️ | ✅ PR Review |
| 多模型路由 | ❌ 单模型 | ✅ | ✅ | ✅ | ❌ |
| 后台/云端 Agent | ❌ | ✅ Cloud Agents | ⚠️ | ❌ | ❌ |
| 测试自修复闭环 | ❌ | ✅ | ✅ | ⚠️ | ❌ |

---

## 三、迭代路线（按梯队，每项含现状/方案/验收/工作量）

### 第一梯队 P0：本地可做、补齐核心短板

#### P0-1 代码库语义索引（对标 Cursor Codebase Index）
- **现状**：只有 `search_files` 关键词/正则，大仓库问"哪里处理鉴权"类问题失效率高
- **方案**：
  1. 轻量先行：AST/正则符号索引（函数/类/导出），结果供 `@符号` 与新工具 `search_symbols`
  2. 完整方案：本地 embedding（bge-small / qwen3-embedding，走 Ollama 或内置 onnx）+ 向量库（better-sqlite3-vss / lancedb），新增 `semantic_search` 工具；索引文件放 `globalStorage/index/`（便于清理）
  3. 增量更新：文件保存事件触发重建该文件索引
- **验收**：在 300+ 文件仓库用语义搜索命中跨文件概念；索引可手动重建/删除
- **工作量**：符号索引 S ｜ 完整向量索引 M-L

#### P0-2 上下文 @/# 引用扩展
- **现状**：`getWorkspaceFiles` 已支持 @文件/文件夹候选
- **方案**：新增 `@diagnostics`（当前报错）、`@git`（diff/status）、`@tabs`（打开的标签页）、`@symbol`（P0-1 符号）；输入时真实解析插入对应上下文
- **验收**：每种 mention 真实可用，点击插入摘要内容；无空候选
- **工作量**：M

#### P0-3 上下文智能压缩（替代硬裁剪）
- **现状**：超 12000 字符直接裁掉最旧消息，丢失关键决策
- **方案**：超限时将旧工具结果/消息交模型 summarize（保留：决策、文件结构、未完成项），摘要替换原文；新增 `compact` 工具可手动触发
- **验收**：长任务压缩后仍能回答早前决策；token 占用下降可测
- **工作量**：S-M

#### P0-4 子 Agent UI 增强
- **现状**：后端能力齐（spawn/await），前端只有工具行，无进度/结果聚合，只能全停
- **方案**：子任务卡片（状态 running/done/error + 耗时 + 结果摘要折叠）；支持单独取消某子任务；多子任务结果分区展示
- **验收**：并行 2 子任务时卡片实时更新，单独取消不影响主 Agent
- **工作量**：M

#### P0-5 Checkpoint 差异审批 UI（对标 Cline）
- **现状**：写前快照已有（内存中），审批只给 vscode.diff，无快照树
- **方案**：每次 Agent 回合形成 checkpoint 组；审批卡支持逐文件 diff 列表 + 单文件允许/拒绝；快照树可视化回滚
- **验收**：一次多文件改动可逐文件审批；快照持久化（重启可恢复）
- **工作量**：M-L（含快照持久化改造）

#### P0-6 MCP Client（对标 Cursor/Trae/Cline 生态）
- **现状**：无
- **方案**：实现 MCP 客户端（stdio + SSE/HTTP transport）；配置化 servers；MCP tools 自动映射进工具通道（复用 executor），resources/prompts 同样接入；设置页真实管理
- **验收**：接入一个真实 MCP server（如 filesystem/github），AI 可调用其工具
- **工作量**：M-L

### 第二梯队 P1：体验深化

| 编号 | 项 | 方案要点 | 工作量 |
|---|---|---|---|
| P1-1 | **多模态输入** | 设置接入视觉模型（豆包/Qwen-VL/OpenAI）；支持粘贴/拖入图片、截图作为用户消息；图片走临时文件 | M |
| P1-2 | **Tab 补全升级** | ① 接真正 FIM endpoint（DeepSeek/Qwen-Coder `/completions` 补全后缀）② 多候选 ghost text ③ 上下文加最近打开文件/相关文件 ④ 多行补全；保留降级路径 | M |
| P1-3 | **Git 原生工作流** | 原生 `git_diff/status/log/commit` 工具（不依赖 shell）；提交信息生成；Code Review（对比分支逐文件评论）；对接 gh 建 PR 面板 | M |
| P1-4 | **规则与模式分层** | 项目级 `.codexcn/rules/*.md` + 全局规则分层加载；UI 切换 Plan/Build/Review/Test 模式（改 systemPrompt 与工具集） | S-M |
| P1-5 | **测试自修复闭环** | Test 模式：自动生成/运行测试 → 失败回喂 → 改到绿；与 P0-5 审批联动 | M |
| P1-6 | **多模型路由** | 不同任务（规划/Tab/子代理/总结）配置不同模型；显示延迟与失败自动降级 | M |
| P1-7 | **终端流式入卡** | `run_command`/后台进程输出实时流式渲染到工具卡片（当前为执行完一次性返回/手动 logs） | S-M |
| P1-8 | **Apply 到编辑器** | 改动以编辑器 edit 形式应用（可撤销栈/ghost 预览），替代直接写盘；Monaco Tab 与文件树已有的 notifyFileWritten 保持联动 | M |

### 第三梯队 P2：扩展形态
| 编号 | 项 | 说明 | 工作量 |
|---|---|---|---|
| P2-1 | 图像生成 `generate_image` | 接外部图像 API + 密钥配置（用户已有规划） | S |
| P2-2 | 后台/云端 Agent | 关闭窗口任务继续（需远端运行时/排队），对标 Cursor Cloud | L |
| P2-3 | 移动端/远程访问 | 用户长期方向：手机安全访问；Web 远程会话 + 鉴权 | L |
| P2-4 | 技能/插件分享 | 技能导出导入、市场雏形 | M |
| P2-5 | 模型能力升级 | 本地 Q4_K_M 4B 指令遵循不稳是当前主要瓶颈，推动更大参数本地模型或云模型默认配置 | — |

---

## 四、推荐推进顺序

```
P0-3 上下文压缩 (S-M) ── 立刻见效，长任务不再丢信息
P0-2 @引用扩展 (M) ── 为后续所有模式提供上下文入口
P0-1 符号索引→语义索引 (先 S 后 L) ── 核心差异化
P0-4 子 Agent UI (M) ── 已有后端，补体验
P0-6 MCP Client (M-L) ── 生态接入
P0-5 Checkpoint diff UI (M-L) ── 安全审批深化
→ 进入 P1 梯队
```
原则（用户既定）：**内核稳定与核心功能优先于命令数量**；无法真实可用的不做假按钮；每个功能 CDP 真实验证后再交付。

---

## 五、环境与操作备忘（防新窗口遗忘）

### 编译 / 构建 / 同步
1. 扩展宿主 TS：
   `node D:\codex-cn-oss\node_modules\gulp\bin\gulp.js compile-extension:codex-cn`
2. Vue 应用（**必须单独跑**，否则 webview 产物是旧的）：
   `node ./esbuild.webview.mts`（在 `extensions\codex-cn` 目录）
3. 同步到运行时（应用需先关闭）：
   `robocopy ...\extensions\codex-cn\out → D:\VSCode-win32-x64\resources\app\extensions\codex-cn\out`
   `robocopy ...\dist → ...\codex-cn\dist`
   （robocopy 退出码 1 = 有复制，正常；退出码 >7 才是错误）
4. 可执行文件名是 **`Codex CN.exe`**（不是 Code.exe）；启动加 `--remote-debugging-port=9222`

### 运行环境
- llama-server：`127.0.0.1:8080`，启动**必须带 `--jinja`**；系统中只保留一个带 --jinja 的进程
- 验证脚本/临时文件统一放：`C:\Users\蒋奎\AppData\Local\Temp\codexcn-verify\`
- 测试工作区：`D:\workflow-test`（临时产物收尾清理，不污染源码树）

### "安装似乎损坏"提示修复
- 触发：核心 `out/` 文件被改但 `resources\app\product.json` 的 `checksums` 未更新
- 修复：重算 checksums（SHA-256 → base64 → 去末尾 `=`）写入 product.json；
  正式打包由 `build/gulpfile.vscode.ts` 自动计算，仅手动同步副本需要手动修
- 2026-09-28 已更新 `workbench.desktop.main.js` 校验和

### 提交规范
- PowerShell 不支持 heredoc：提交信息写临时文件 → `git commit -F`；
  push 用 `git push --no-verify fork codex-cn/custom`（partial clone 下绕过 git-lfs pre-push）
- 不擅自 commit/push，等用户明确指令；独立分支开发，验证+回归后才合并
