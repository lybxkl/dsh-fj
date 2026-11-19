# 格式匠论文助手（DSH 插件）

把本机格式匠的论文工具接进 DeepSeek Harness。插件自己**不实现**论文能力，职责是：找到格式匠、维护工具连接、跑宿主通道（附件收件与会话身份）、把状态和结果讲清楚。所有论文操作仍然是格式匠提供的 `mcp__formatjiang__*` 工具。

> 这里是不带截图的简版。完整说明在 [docs/README.md](docs/README.md)：`mountScope` 与「格式匠」预设怎么接入、装好之后三步怎么点（带图）、断线与装配失败的排查。

## 装之前需要满足的条件

1. 本机装了格式匠（Windows 桌面版），并且本机 MCP 服务是开启状态：格式匠 → 设置 → MCP →「本机服务」里「启用 MCP 本机服务」已打开，并点过「保存并应用」（下面能看到监听端口，默认 48654）。
2. 格式匠里有一条**本机 stdio 安装**：格式匠 → 设置 → MCP → 右上「连接外部助手」→「连接哪个助手」选「其他本机客户端（stdio 桥接）」→ 应用。弹出的是「连接外部助手」对话框（`MCPGatewayPanel.vue`），不是「本机服务」页里的 Token/Endpoint 区块。记下生成结果里的 `ins_` 开头安装 ID。插件会优先读格式匠数据库里这条记录；读不到就按配置里的 `installationId` 走。
3. DSH 里 `@deepseek-ai/dsh-mcp-client` 处于启用状态（官方 profile 默认启用）。插件只是往它上面注册一台服务器，不会自己再插一份。

## 安装

把本目录链接进 profile 并登记为 bundle（以 `desktop` profile 为例，路径按实际改）：

```powershell
$profile = 'C:\Users\<你>\.dsh\profiles\desktop'
$target  = Join-Path $profile 'node_modules\@local\formatjiang-assistant'
New-Item -ItemType Junction -Path $target -Target 'D:\GoRoom\docx-cli\dsh-plugin'
```

然后在这两处各加一项，重启 DeepSeek Harness：

- `package.json` → `dependencies`：`"@local/formatjiang-assistant": "link:D:/GoRoom/docx-cli/dsh-plugin"`
- `package.json` → `dsh.profile.bundles`：`"@local/formatjiang-assistant"`

## 配置

改 profile 里的 `cordis.patch.yml`（`- insert:` 下这条 `id: formatjiang-assistant` 的 `config`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `executablePath` | 空 | 格式匠程序路径。留空时依次试 `FORMATJIANG_HOME`、桌面 `formatjiang` 目录、`%LOCALAPPDATA%\Programs\formatjiang`、`%ProgramFiles%\formatjiang` |
| `installationId` | 空 | 本机安装 ID。留空时从格式匠数据库里挑一条未吊销的 stdio 安装，优先 `dsh`，其次 `generic_stdio` |
| `dataDir` | 空 | 格式匠数据目录。留空时用 `FORMATJIANG_DATA_DIR`，再退到 `<用户主目录>\formatjiang-data` |
| `mountScope` | `host` | 桥接挂在哪：`host` = 插件在宿主层挂（每个会话都可见）；`preset` = 交给「格式匠」预设里的官方 mcp 客户端（只有选那个预设的会话可见，省下每轮的工具体积）；`off` = 都不挂。宿主工具（附件、会话）两种模式都可用，见下一节 |
| `startupTimeoutMs` | 90000 | 首次拉起格式匠并等桥接可用的上限 |
| `toolCallTimeoutMs` | 270000 | 单次工具调用超时。格式匠网关自己的写超时是 5 分钟，超过一定被掐断，这里只留 30 秒余量 |
| `autoReconnect` | `true` | 宿主放弃重试（`failed`）后，插件按 15、30、60 秒各重挂一次；装更新、用户完全退出格式匠时不重挂 |

## 两条通道（为什么预设模式下附件还能用）

插件维护两条互不依赖的路，排障时先分清是哪一条出问题：

- **业务工具** `mcp__formatjiang__*`：由 MCP 桥接提供。`mountScope: host` 时插件在宿主层挂桥接，每个会话都看得见；`mountScope: preset` 时挂载交给「格式匠」预设里的官方 mcp 客户端，只有选那个预设的会话看得见。格式匠退出后它们会从工具表消失，重连回来后外部服务工具名还可能带新的随机后缀。
- **宿主工具** `formatjiang_*`：不经过桥接。附件收件、会话绑定、稿件导入、成品取回这些动作按需执行一次 `格式匠.exe mcp host --installation-id <id> --chat-id <会话>`，只要求「程序 + 安装 ID + 格式匠在运行」，与工具表里有没有业务工具无关。

所以：插件页把桥接写成「由「格式匠」预设提供」时，附件与会话工具照常可用；反过来，业务工具在表里也不代表宿主通道一定可用（缺安装 ID、正在装更新、手动断开时它会明确说缺什么）。`formatjiang_status` 的 `hostChannel` 字段报的就是第二条通道，`usable` 表示这套接入有没有配置层面的故障。

## 它给了你什么

**工具（11 个，都归宿主这份：连接诊断 + 聊天身份与附件搬运，不代理业务）**

- `formatjiang_status`：桥接与宿主通道各自的状态、工具数量、重试进度、最近错误、程序与安装 ID 是否找到。连不上时先看它。
- `formatjiang_connect`：重新发现并挂载桥接。改完配置、或 DSH 放弃重连（重试 10 次后）用它；`mountScope: preset` 时它只说明「不用重连」，因为此时没有归宿主管的连接。
- `formatjiang_open`：打开格式匠。格式匠没运行时桥接连不上，先开它。
- `formatjiang_diagnostics`：生成一段可直接复制到工单里的接入信息：状态、程序路径、安装 ID、数据目录、两条通道的状态、最近一次错误原文。**不含 token**。
- `formatjiang_catalog`：列出网关当前暴露的工具、固定资源、资源模板与提示词（名字与一行说明）。用户问「连上了能用哪些」时用它；读一次缓存 10 分钟，`refresh: true` 重新问。
- `formatjiang_disconnect`：主动断开桥接并暂停自动重连，方便调试「连不上」的一侧。断开后所有 `mcp__formatjiang__` 工具都不可用，直到下一次显式连接。
- `formatjiang_stage_attachment`：把用户指定的本机文件复制进格式匠收件区并登记成附件，返回 `file_id`；走宿主通道，不依赖业务工具在不在表里。
- `formatjiang_session`：读取、绑定或解除本次真实聊天的当前论文。
- `formatjiang_import_document`：把已接收的附件导入格式匠，新建论文或往既有论文追加版本。
- `formatjiang_use_attachments`：在本次聊天里使用已接收的附件——导入知识库或整理投稿包。
- `formatjiang_save_file`：把格式匠的 `file_id` 保存成本机文件，校验大小与摘要后才算成功。

**连接后获得的能力清单**

连上之后，插件页与设置页会像格式匠自己的「测试连接」面板那样摊开：工具的个数与名单、固定资源、资源模板、提示词，外加服务名与协议版本。数据来自 `格式匠.exe mcp describe --installation-id <id>`——它和桥接读同一份安装描述、走同一套回环校验，只连一次、问完就关。

**这个清单要装带 `mcp describe` 的版本**。旧版本会把这个调用当成启动 GUI，插件识别出「没有清单接口」后只显示一行升级提示，不会把它画成「0 个工具」。

**技能 `formatjiang-paper`**

技能正文按任务链组织：从收稿到交付、套版、提交检查、引文核对、找格式与共坊、资料与投稿、断线恢复。模型只在真要做这些事时才用 `skill` 工具加载，不占每轮系统提示词：

1. 新稿从对话走到成品：`formatjiang_stage_attachment` 把文件复制进收件区并自动登记（这一段的宿主通道不依赖业务工具）→ `formatjiang_import_document` 建论文或追加版本 → `formatjiang_session` 绑定会话 → `read_document_outline` / `read_document_chunk` / `search_document` 读稿 → `create_structure_plan` / `confirm_structure_plan` 确认结构 → `preview_layout_plan` → `apply_layout_as_branch` → `start_diagnostic_run` / `get_diagnostic_status` / `list_findings` 检查 → `generate_commented_docx` / `generate_revision_draft` / `export_diagnostic_report` 导出 → `formatjiang_save_file` 取回成品。
2. 套版：`list_papers` → `list_versions` → `list_layout_configs` → `preview_layout_plan`（可带套用范围）→ 把冲突与影响讲清楚 → 用户明确同意后 `apply_layout_as_branch`。
3. 提交检查：`list_diagnostic_profiles` → `start_diagnostic_run`（或同步 `run_paper_diagnostic`）→ `get_diagnostic_status({ run_id, wait_seconds: 120 })` 一直等到 status 不是 running（还在跑就再调一次，最多 180 秒一次）→ `list_findings` 分页读问题，数字必须有工具结果出处。结果在对话里给出来，不要让用户切到应用里自己看。
4. 引文页码核对：`preview_citation_check` → `start_citation_check` → `list_citation_check_items` → `get_citation_check_item`；缺来源时 `list_citation_source_candidates` 与 `preflight_citation_source`。
5. 找格式与共坊：`search_forge_templates` → `get_forge_template` → `check_forge_import` → 用户确认后 `import_forge_template`；版式生成任务用 `list_layout_generations` 与 `list_layout_generation_events` 续读。
6. 资料与投稿：`create_knowledge_base` / `import_knowledge_base_files` → `get_rag_run({ run_id, wait_seconds: 120 })` 守到解析结束；`search_knowledge_base` 与跨库 `search_knowledge_bases`；投稿前 `inspect_blind_review`，交付 `build_submission_package`。
7. 断线恢复：`list_interrupted_tasks` 盘点，`resume_import_recovery` 决定资料导入续跑或取消。
8. 审稿意见与回复信：`get_research_context` / `list_submission_requirements` 读口径，`list_review_items` 逐条读意见，`summarize_review_items` 给进度，`export_response_letter` 出回复信并用 `fetch_file` 取回。
9. 星轨：`get_symphony_state` 读状态与运行索引，`get_symphony_report` 读论证审查覆盖（`determined` 与 `insufficient` / `blocked` 分开说），`get_symphony_source_evidence` 读已登记来源证据。
10. 工坊：`list_workshop_runs` 列运行，`get_workshop_run` 读阶段与发现项，`read_workshop_artifact` 按 key 读产物正文（含截断标注）。

技能正文还写了连接异常时先查状态、写操作边界（十七项写工具都受 safe-write 开关约束），以及「卡片已展示的内容不要复述」。

**命令 `/formatjiang`**

- `/formatjiang`：一行状态。
- `/formatjiang 诊断`：等价于 `formatjiang_diagnostics`，输出可复制的接入信息。
- `/formatjiang 重连`：卸载旧连接并重新挂载桥接。

**对话里的工具卡**

- 套版方案卡（`mcp__formatjiang__preview_layout_plan`）：判定徽章（通过 / 需要确认 / 已阻断 / 旧版回退）、影响段落数、版式项数、冲突条数与前三条、受保护内容（节 / 表格）、清理会删掉的处数、前四条版式规则及各自影响处数、确认令牌有效期，以及「回复确认套版」的下一步。判定为 `block` 时明确写「没有可用令牌」。
- 提交检查卡（`mcp__formatjiang__run_paper_diagnostic` 与 `mcp__formatjiang__list_findings` 共用一张）：错误 / 警告 / 提示三项计数、逐条问题与定位（来源 + 段落序号 + 摘录）、「只看错误」筛选、「在格式匠中查看报告」与「复制运行 ID」。检查跑完源文件又变过时，卡片会直接写「不能当作当前文件的结论」。
- 状态行（4 个连接工具）：一行，不铺开。

解析不出结构时一律退回原文并标注「未解析」，不编造字段。

**设置页（设置 → 格式匠）**

插件详情页不好找，所以设置侧栏里另给一个同名入口（槽位 `settings.section`，`id: formatjiang`，排在「表情包」之后）。这一页面向第一次用的人：

1. 三步接入清单，每步都写当前状态与下一步点哪里——MCP 服务是否开启（带上本机端口）、有没有可用的本机安装（带上安装 ID 与类型）、桥接通没通（带上工具数或错误原文）。
2. 与插件页共用的三个动作：打开格式匠、重新连接、复制诊断信息（同一套 `useConnectionActions`，行为不会两处不一致）。
3. 「在对话里怎么用」四条示例：套版、提交检查、取证、排障。
4. 本机信息：程序、安装、数据目录、连接方式。

**插件页（插件详情页）**

`plugins.bundle.config` 里的连接卡：状态、工具数、写入是否需要确认、连接方式、本机端口、程序与安装 ID、数据目录、插件版本。连接断开时给出最近一次错误的原文、自动重试倒计时，以及「打开格式匠」「重新连接」「复制诊断信息」三个按钮。数据来自同源接口 `/formatjiang/api/state`，只允许本机同源页面访问。

## 明确不做的事

- 不代理、不缓存格式匠的业务工具；工具列表完全由格式匠按发布组决定。
- 不读、不保存 token。桥接描述（端点与 token）由格式匠写在受保护存储里，只有桥接进程自己读。
- 不替换 `dsh-mcp-client` 的重连策略。桥接断线由 mcp-client 退避重连，本插件只在「放弃之后」提供一次手动重连。
- 不做格式匠业务规则：写操作的安全边界仍在格式匠一侧（`confirmation_token`、`safe_write`）。
- 不渲染配置表单。配置仍在 `cordis.patch.yml` 里改，插件页只读状态。

## 限制

- 单次工具调用超过格式匠网关 5 分钟写超时会被掐断；`toolCallTimeoutMs` 只是本地等待上限，不能延长服务端。
- **「在格式匠中查看报告」不是深链**。格式匠目前没有 URL scheme（`main.go` 只转文件与 URL 打开事件，`handleMacUrlOpen` 仍是预留），诊断报告又是数据库记录、没有文件路径，所以这个按钮只能唤起格式匠，再由「复制运行 ID」把运行 ID 交给用户在格式匠里查找。等格式匠支持 `formatjiang://` 深链后，这两步可以合成一步。
- 同一台机器多个 DSH 会话共用一个桥接进程时，各会话共用同一份格式匠安装与工具目录。
- macOS 未验证；本插件按 Windows 的路径与进程行为编写。
- 桥接进程是格式匠可执行文件本身。它没有窗口、不读数据库写、不监听端口，但会占用该 exe 的文件句柄。更新脚本现在会先落 `update-in-progress.marker`，桥接两秒内自行退出、脚本等文件释放后再装；这套握手要等含该逻辑的构建才生效，首次更新仍需先关插件或结束无窗口的 `格式匠.exe`。

## 断线之后

1. **宿主自己在试**：`dsh-mcp-client` 按 0.5→30 秒退避重试十次（约 150 秒），期间插件只显示「重新连接中」与剩余秒数，不插手。
2. **宿主放弃了**：状态变 `failed`、工具被撤掉。插件此时按 15、30、60 秒各重挂一次，插件页写清「约 N 秒后自动重连（第 N 次）」。
3. **不该重挂的时候**：安装目录有 `update-in-progress.marker`（正在装更新）就等，装完自动接；错误是「用户完全退出格式匠」就先探网关端口，你手动打开格式匠后才接回。
4. **三次都没成**：停止重试，页面写明「自动重连已停止」。你处理完格式匠那边的问题点「重新连接」即可，这次点击会重新记一轮。
5. **你自己断开**：插件页或设置页的「断开连接」、工具 `formatjiang_disconnect`、命令 `/formatjiang 断开` 都会卸掉桥接并暂停自动重连——调试断线表现时用它，恢复点一次「重新连接」。

## 稳定性与资源

插件跑在宿主进程里，所以所有会等、会重、会起进程的地方都设了上限，不存在「一直等」或「越等越频繁」的路径：

| 位置 | 上限 / 处理 |
|---|---|
| 插件页轮询 | 8 秒一次；页面切到后台时不再请求；连续失败 3 次后降到 24 秒一次；切回前台立刻刷新。定时器在卡片卸载时清掉 |
| 面板请求 | 请求体 64KB、读取超时 15 秒；超限回 413、超时回 408，然后主动断开，不占着连接 |
| 页面上的每个请求 | 10 秒上限（AbortController）。失败或超时都会把按钮放回可点状态并写明原因，不会永久禁用 |
| 重连 | 单飞：正在重建时第二次调用直接返回 429，不排队、不叠加注册；失败只记录原因，不留半挂状态，再点一次即可重试 |
| 打开格式匠 | `spawn` 的同步异常与异步 `error` 事件都会被接住并写进状态提示；插件不会因此崩，也不会反复拉起 |
| 自动重连 | 只在宿主 `failed`（十次退避用尽、工具被撤掉）后动手：15、30、60 秒各重挂一次，连上即清零，三次用尽就停并在插件页说明。`connecting` / `reconnecting` 阶段不插手，避免两套退避打架 |
| 自动重连的例外 | 安装目录里有 `update-in-progress.marker`（正在装更新）时不重挂；错误是「用户完全退出格式匠」时先探一次网关端口，端口通了才接回，没开就保持安静 |
| 桥接进程 | 由宿主按 mcpManager 的生命周期管理；插件卸载或 effect 清理时调用 dispose，不保留自己的长连接 |
| 状态读取 | `mcp_settings.json` 有 2 秒缓存；`/state` 不打开格式匠数据库，只有「重新发现安装」时才只读打开一次并立即关闭 |
| 能力清单 | 只在已连接时读，走一次 `mcp describe`（20 秒上限）；成功缓存 10 分钟、失败缓存 6 小时，条目与描述都封顶，避免每次轮询都执行程序、把状态响应撑大 |
| 工具卡渲染 | 问题清单只渲染前 8 条（其余给「另有 N 条」），结果解析按文本缓存，切换筛选不会重新解析大 JSON |

## 与宿主的契约对照

宿主对这些注册对象**不做字段校验**：字段名写错不会在挂载时报错，只会在下一次使用时炸在不相关的地方，所以改动前后都按这张表核一遍（路径相对于 DSH 安装目录下的 `app.asar/dsh/node_modules/@deepseek-ai/`）。

| 本插件用法 | 宿主契约与位置 |
|---|---|
| `systemPrompt.section({ name, order, text, interpolate })` | `PromptSection` 在 `dsh-system-prompt/src/index.ts:53-76`，注册方法在 `:485`。字段是 **`text`**，没有 `content`；`renderPrompt` 在 `:297-302` 对分节做 `text.length`，缺 `text` 会在每轮装配时抛 `Cannot read properties of undefined (reading 'length')` |
| `tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))` | `register` 在 `dsh-tools/src/index.ts:128`，`defineTool` 在 `dsh-tools/src/schema.ts:555`；`output` 必须含 `schema` 与 `render` |
| `mcpManager.register(name, { transport, command, args, startupTimeoutMs, toolCallTimeoutMs })` | `dsh-mcp-manager/src/index.ts:288`；`list()` 返回 `{ name, configured, status }`（`src/types.ts:24-31`） |
| `skills.register({ name, description, whenToUse, source, content })` | `dsh-skill/src/index.ts:439`（`SkillRegistry.register`）；`source` 是必填（`SkillSummary.source`，`:40`/`:69`），`provider` 缺省 `runtime`（`:450`），`invocation` 缺省模型与用户都可调用（`:449`）；名字必须是 kebab-case（`validateRuntimeSkill`，`:741-745`） |
| `commands.register({ name, description, input, handler })` | `dsh-commands/src/index.ts:285`；`handler` 收到 `CommandInvocation{ commandId, agent, rawInput, attachments, signal }`（`:41-58`），必须返回 `{ kind: 'success' \| 'error', text }`（`src/types.ts:34-41`）；命令不能发起模型轮次 |
| `webServer.register({ kind: 'prefix', path, handler })` | `dsh-host-webserver/src/index.ts:445`，`WebRoute` 在 `:52-58` |
| `ctx.slots.inject(key, fn)` / `ctx.slots.register({ name, key }, Component)` | `dsh-client-ui-renderer/src/client/registry.ts:209`（`inject`）与 `:741`（`register`）；`tool.call.toolview` 的 `props` 是 `{ phase: 'preparing' \| 'start' \| 'result', block, toolName, ... }`，`result` 阶段的 `block` 才是含 `content` 的结果节点 |
| `ctx.slots.register({ name: 'settings.section', id, order, label }, Component)` | 分节是 list 槽位，`id` 同时是导航行的 key，内容用 `renderSlot('settings.section', { close }, { only: active })` 按 id 过滤；`dsh-client-ui-settings-general/lib/client.js` |
| `ctx.slots.register({ name: 'settings.section.icon', id, order, label }, Icon)` | 图标是另一个 list 槽位，**注册 id 必须等于目标分节的 id**，否则永远不渲染；组件收到 `{ size, active }` |
| 槽位组件的返回值 | 条目会被当成 React 组件渲染（`jsx(Comp, props)`），但**元素类型只能是字符串或函数**：把元素当组件传（`h(SomeElement())`）会抛 `Element type is invalid … got: object`，宿主用 `SlotErrorBoundary` 接住后只留一片空白（`div[data-slot-error]`），页面上什么都看不到。测试替身的 `createElement` 已按同一条规则拒绝非法类型 |

## 测试

```powershell
cd D:\GoRoom\docx-cli\dsh-plugin
npm test
```

两组用例都不需要 DSH 运行时：Host 侧用替身 ctx 校验桥接条目、十一个工具、系统提示节、技能、命令与面板鉴权；Client 侧用最小 React 替身摊平组件树，校验槽位注册、插件页连接卡（含「需要修复」态）、两种工具卡的解析与降级。
