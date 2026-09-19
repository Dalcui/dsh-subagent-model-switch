# DSH 子代理会话界面手动切换模型 —— 可行性调研报告

> 调研日期：2026-（本会话） ｜ 版本：@deepseek-ai/dsh 0.1.5-rc.1 ｜ 结论：**技术上可行，官方刻意不提供，实现分两个层次**

## 一、结论速览

| 问题 | 答案 |
|---|---|
| 主会话为什么能切换模型 | Web composer 的 `conversation.input.model` seat → `session/selectModel` RPC → 服务端给该 agent 安装"下一次请求模型选择"，下次请求走 `agent/request` waterfall 被覆盖 |
| 子代理会话界面为什么不能切换 | ① 前端 ModelSelect 对子代理会话显式禁用（available=false，直接不渲染）② 后端 `selectModel` 对子代理会话**一律拒绝**（`ApiSessionSubagentOwnership`，live 与 cold 同样被拒，`liveAgent` 内也有所有权检查）③ 子代理视图的 composer 被替换为只读提示 |
| 能不能实现 | **能**。但不能复用现有 `selectModel` RPC（对 live 子代理同样报错）；需 host 插件**自建 RPC**：`ctx.agents.get` 拿 live 子代理 agent → 自建 selection → `installModelSelection` → 下一次请求经 `agent/request` waterfall 生效。仅对"运行中且父在线的可继续子代理"有意义 |
| 官方为什么不提供 | 所有权边界设计：子代理会话生命周期归"直接父代理的持续控制路径"，通用 Agent-bound 控制刻意拒绝（拒绝分类器含 exact live runtime ownership）；另有 KV Cache 前缀复用考量 |

> ⚠️ **实测补充**：方案 B 已落地并在真实环境实测，暴露两个此前未写明的结论——**后端改动必须重启进程才生效**、**子代理路径没有"模型切换"上下文注入**（结构性缺口，重启也不能补齐）。详见 **第七节**。

> ⚠️ **修正记录**：本报告初版曾论断"live 子代理可经 selectModel 绕过所有权检查、后端已通"，经 subagent 源码审查证伪（§5.1）：`liveAgent()` 对命中的子代理 agent 仍执行 `hasApiSessionSubagentOwner`，live 与 cold 一样被 `session/agent-busy` 拒绝。本版已按审查结论修正。 |

---

## 二、主会话模型切换的完整链路（现状机制）

### 2.1 前端
- `@deepseek-ai/dsh-client-ui-model-selection` 提供 `ModelSelect` 组件，挂在 composer 输入栏的 `conversation.input.model` seat（`dsh-client-ui-conversation` 第 16184 行 `renderSlot("conversation.input.model", { locked: modelSeatLocked })`）。
- 点击选择 → `sessions.selectModel({ sessionId, provider, model, reasoningEffort })` RPC（`dsh-client-connection` 中 `case "session/selectModel": return sessionApi.selectModel(request)`）。

### 2.2 服务端（`@deepseek-ai/dsh-api-session-controller`）
`SessionController.selectModel`：
1. `llm.resolveCallConfig({ provider, model, reasoningEffort })` —— 实时校验路由（provider 注册、精确 model、effort 校验、适配器默认值）
2. `agents.selectForNextRequest(agent, selected)`：
   - `agent.session.append('model/selection', selection)` —— **持久化**为会话事件
   - `this.selectionFor(agent).current = selection` —— 设置内存中"下一次请求"选择（一次性）
3. `agentDefaultModel.saveSelection(selected)` —— 同时保存为默认模型

### 2.3 生效机制（`@deepseek-ai/dsh-agent` 的 `installModelSelection`）
对每个 agent 的 scoped context 注册三个监听器：
- `system-prompt/assemble`：把选中 provider/model 写入系统提示词变量
- `agent/request`：**在请求组装 waterfall 中把选中路由覆盖到请求配置**（这是核心）
- `agent/pre-step`：插入一条用户角色"模型切换"通知消息（`modelSwitchNotice`，比较最新 request header）

`agent-loop` 的 `prepareRequest` 每次请求：
1. `persistedHeader = session.requestHeader()` + `route = { provider: this.options.provider, model: this.options.model }`（AgentOptions 基线）
2. seedConfig → `waterfall("agent/request", ...)` → 被 selection 覆盖
3. `llm.prepareCall(proposedConfig)` → `buildRequest` 持久化 `request/header`（reason: "change" 或 "series"）→ 请求生效
4. 请求完成后 `consumeSelection(agent, provider, model, effort)` 消耗（一次性）

> 关键点：**模型选择是"下一次请求一次性生效"**，通过事件（model/selection、request/header）持久化，可恢复（resume 后从 requestHeader 恢复）。

---

## 三、子代理会话为什么不能切换（三重禁用）

### 3.1 前端显式禁用（`dsh-client-ui-model-selection`）
- 第 922/947 行：`available: (session) => sessions.subagentAddress(session.sessionId) === void 0` —— **子代理会话（有 subagentAddress）→ available = false**
- 第 493 行：`ModelSelect` 组件 `if (!available) return null` —— **直接不渲染**
- 第 201/926/930 行：load/select 抛 `"model selection is unavailable for addressed subagent sessions"`

### 3.2 后端显式拒绝（`dsh-api-session-controller`）
- `ApiSessionSubagentOwnership` 错误："session is owned by subagent routing"
- `resolve(sessionId)` 中 `hasApiSessionSubagentOwner(ctx, session, agent)`（`session.header.origin === 'subagent'` 或父链属于子代理）→ 返回 `session/agent-busy` 错误
- ~~例外（初版误判）~~：`liveAgent`（第 395-402 行）虽能通过 `ctx.agents.get` 命中 live 子代理 agent，但**命中后仍执行 `hasApiSessionSubagentOwner`**，子代理命中即返回 `apiSessionSubagentOwnershipError` —— **live 与 cold 同样被拒**（见第五节审查修正版）

### 3.3 子代理会话 UI 只读（`dsh-client-ui-subagent`）
- `SubagentReadOnlyComposer`（priority: -10 抢占 `conversation.composer` seat）：一次性子代理永远只读；可继续子代理在父离线时只读（"此子代理暂时只读" / "父会话当前不在线"）
- `SubagentHeaderLineage` 挂在 `conversation.session.header.lineage`：只显示谱系树、状态（running/inactive）、token 用量、活动时长
- 子代理会话模型在创建时固定：`resolveChildAgentOptions(parent, request.agentOptions, childDepth)`（fork 继承父级；subagent 工具可显式 provider/model/effort）→ 持久化在 `subagent/descriptor`（agentProvider/agentModel/agentReasoningEffort）+ request header

---

## 四、官方设计意图（为什么刻意不提供）

来源：`.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.md`（官方实现笔记）

> "Agent-bound auxiliary controls are unavailable in addressed child views. In particular, **the model selector and /model contribution do not call ordinary session.models or session.selectModel**; the Host also rejects any accidental call instead of activating persisted child history outside the direct-parent continuation path."

- **所有权边界**：子代理会话的生命周期归"exact direct-parent continuation path"（直接父代理的持续控制路径）。通用 Agent-bound 控制（含 selectModel）刻意拒绝子代理会话，防止绕过父代理权限、"激活"子代理持久化历史。
- **KV Cache 复用**（`2026-08-18-model-selected-subagent-routes.md`）：fork 子代理继承父级 provider/model，是为了"copied conversation prefix remains eligible for provider-side KV Cache reuse"。切换模型会破坏前缀复用，需重算前缀，成本可能超过委派任务本身。官方因此**刻意不为 fork 提供模型选择**（"随附 fork 工具不能选择子级 LLM 路由"）。
- 官方提供的模型选择能力定位在**创建时**：`dsh-tool-subagent` 的 `modelSelectionSettings: true` + `provider`/`model`/`reasoning_effort` 工具参数 + `list_subagent_models` 发现工具（逐会话授权策略 `subagent-model-selection` 设置），由**模型**在调用委派工具时选择，而非用户事后在界面切换。

---

## 五、可行性分析（能否实现）

### 5.1 层次一：运行中（live）的可继续子代理 —— 不能复用 selectModel，需插件自建 RPC

> ⚠️ 本节为审查修正版。初版错误论断"liveAgent 直接返回、绕过所有权检查"已被证伪。

代码路径分析（`selectModel` RPC 对 live 子代理 agent）：
1. `resolveAgent(sessionId)` → `resolve()` → `liveAgent(sessionId)` = `ctx.agents.get(sessionId)` 拿到 live 子代理 agent —— **但 `liveAgent` 仍执行 `hasApiSessionSubagentOwner`**（agent.js:395-402，子代理 header.origin==='subagent' 命中），返回 `apiSessionSubagentOwnershipError` → `resolve` 直接返回该 error → `resolveAgent` throw `session/agent-busy`
2. **结论：live 与 cold 子代理同样被现有 `selectModel` RPC 拒绝**；官方设计笔记证实为刻意设计（"the Host also rejects any accidental call"，拒绝分类器含 exact live runtime ownership by the parent）

**可行的替代路径（host 插件自建 RPC，绕开 session 路由层）：**
1. `ctx.agents.get(childSessionId)` —— 插件 ctx 上 `ctx.agents`（AgentRegistry）公开，可直接取 live 子代理 agent（dsh-agent/lib/index.js:563-565）；子代理与主 agent 同注册表（one-shot 经 `parent.ctx.agents.create`，continuable 冷恢复经 `ctx.agents.resume`）
2. 构造 selection 对象（`current` getter/setter、`consume`、`assembled`）—— `modelSelection` projection 已全局注册可复用（api-session-controller/index.js:2039-2049、280-281）
3. `installModelSelection(agent.ctx, selection)`（dsh-agent/lib/index.js:669 公开导出，133-177 注册 assemble/request/pre-step 三个 scoped 监听，对任意 agent 有效）
4. `selection.current = { provider, model, reasoningEffort? }` → 子代理下一次请求 `agent/request` waterfall（dsh-agent-loop/lib/index.js:1143）覆盖为新模型 → `request/header` 持久化 change

限制：
- 只对 **live**（正在运行/已加载）的子代理 agent 有效
- **一次性子代理**（one-shot）无意义：执行记录只读，不会再发起请求
- **cold（已结束/未加载）可继续子代理**：需父代理在线经 continuation 管理器 resume（resume 时模型取自 descriptor 而非 model/selection 事件，见 5.2）

### 5.2 层次二：通用（含 cold resume、父离线）—— 需要较大改动

- 需要 subagent 路由层新增专用 RPC（如 `subagent.selectModel`）或在 selectModel 中放行子代理分支
- cold 可继续子代理的模型选择需在 resume 时应用（resume 需要 exact live 父代理）
- 需处理 KV cache 前缀变化（切换模型后子代理历史前缀失效，重算成本由用户承担）
- 需定义与"direct-parent 所有权"一致的安全模型（谁有权限给子代理换模型：父代理？用户？）

### 5.3 可行性结论

| 场景 | 可行性 | 改动量 |
|---|---|---|
| 运行中的可继续子代理切换模型（下一次请求生效） | ⚠️ **有条件可行**：现有 selectModel 对 live 子代理同样被拒，需 host 插件自建 RPC（ctx.agents.get + installModelSelection）；client 插件注入选择器 | 中（client+host 插件，不碰 DSH 源码） |
| cold 可继续子代理 resume 前切换模型 | ❌ 不可行：resume 路线取 descriptor 固定模型，且需 exact live 父代理 | — |
| 一次性子代理 | ❌ 无意义（不会再请求） | — |
| 修改 DSH 源码 | ⚠️ 会被更新覆盖（AGENTS.md 约定需先获同意）；后端需改 liveAgent/resolve + 处理全局默认模型副作用 | 见 5.4 |

### 5.4 实现路径建议（按推荐顺序）

**方案 A：插件实现（不改 DSH 源码，推荐；前提已按审查修正）**
- **host 插件**：自建 `subagent.modelCatalog` / `subagent.selectModel` RPC（**不能复用现有 session.selectModel**，其对 live 子代理同样报 session/agent-busy）：
  1. `ctx.agents.get(childSessionId)` 取 live 子代理 agent（不存在或非 continuable → 明确错误"需父代理在线"）
  2. 自建 selection 对象，`installModelSelection(agent.ctx, selection)` 安装，`selection.current = { provider, model, reasoningEffort? }`
  3. **不调用 `agentDefaultModel.saveSelection`**（避免污染全局默认模型）
  4. 注意：自建 selection 不被 controller 的 `consumeSelection` 消耗（WeakMap 隔离）→ 行为是"持续保持"，需自行定义一次性/持续语义
- **client 插件**：在子代理会话视图（仅 continuable 且父在线）注入模型选择器；**不能复用 `ModelDirectory`**（其 available 已烘焙 available=false），需自建目录 RPC（可复用 `ctx.remote.session.modelCatalog()` 拉模型目录）
- 坑：切换会经 `agent/pre-step` 向子代理转录插入"模型切换"通知；切换后 KV cache 前缀失效（fork 尤其）；`model/selection` 事件持久化对 cold resume 无效
- 优点：可随插件卸载；符合"扩展优先于改核心"

**方案 B：修改 DSH 源码（部分可行，改动比初版评估更大，需先征求用户同意）**
1. 前端 `available` 判断共 4 处需放开：`dsh-client-ui-model-selection/lib/client.js` 922（/model 命令）、947（seat）、201/493（assertAvailable/不渲染）、305（directory）；live+父在线时普通 composer 本就渲染 `conversation.input.model`（conversation:16186），放开即出选择器—— **UI 改动小**
2. 后端**并非天然放行**：需改 `liveAgent`（agent.js:395-402）或 `resolve` 增加 live 子代理放行分支，并处理 `selectModel` 的 `agentDefaultModel.saveSelection` 全局默认模型副作用（index.js:621）
3. `dsh-client-ui-subagent`：在子代理视图渲染模型选择器（仅 continuable）
4. 注意：每次 `npm update @deepseek-ai/dsh` 会覆盖，需维护 patch

**方案 C：不改任何代码，用现有能力满足需求（最稳妥）**
- 创建时指定：subagent 工具 `provider`/`model`/`reasoning_effort` 参数 + `list_subagent_models`（官方 `modelSelectionSettings: true` 组合）；AGENTS.md 已约定"启动 subagent 时指定 model: provider/model-id"
- fork 继承父级：在**主会话**先切好模型再 fork 子代理
- 可继续子代理：如果接受"创建后换模型需要重启子代理"，可对已结束的子代理 fork 出新会话（fork 继承父级当时模型）
- 适合"够用就行"，零风险

### 5.5 技术注意事项
- **模型切换对子代理是"下一次请求生效"**（与主会话一致），正在执行中的轮次不受影响
- 切换后 `request/header` 记录 reason: "change"，会话历史可回放；`model/selection` 事件持久化
- **KV Cache 前缀失效**：切换 provider/model 后，该子代理会话的既有前缀缓存失效，后续请求需重算（fork 场景尤其明显，官方因此限制 fork 选择）
- 一次性子代理会话即使加了 UI 也无意义（不会再发起模型请求）
- `subagent-model-selection` 设置只影响**创建时**的模型选择（新顶层 Session 快照策略），与运行时切换无关

---

## 六、关键代码位置索引（0.1.5-rc.1）

| 位置 | 文件 |
|---|---|
| 主会话模型选择 RPC | `@deepseek-ai/dsh-api-session-controller/lib/index.js` `selectModel`（605 行）|
| 模型选择安装/生效 | `@deepseek-ai/dsh-agent/lib/index.js` `installModelSelection`（133 行）|
| 子代理所有权拒绝 | `@deepseek-ai/dsh-api-session-controller/lib/types/agent.js` `ApiSessionSubagentOwnership`（62 行）、`hasApiSessionSubagentOwner`（106 行）|
| live agent 所有权检查（不绕过） | 同文件 `resolve`（217 行）/ `liveAgent`（395-402 行，命中子代理仍返回 ownership 错误）|
| 插件自建 RPC 的可用设施 | `dsh-agent/lib/index.js` `AgentRegistry.get`（563-565）、`installModelSelection` 导出（669）；`dsh-api-session-controller/lib/index.js` modelSelection projection（2039-2049）、consumeSelection（2762-2764）|
| 前端模型选择可用性 | `@deepseek-ai/dsh-client-ui-model-selection/lib/client.js`（201/493/922/947 行）|
| 子代理只读 composer | `@deepseek-ai/dsh-client-ui-subagent/lib/client.js` `SubagentReadOnlyComposer`（717 行）|
| 子代理创建模型解析 | `@deepseek-ai/dsh-subagent/lib/types/continuation.js`（112 行）、`child-agent.js` `resolveChildAgentOptions`|
| 子代理描述符模型字段 | `@deepseek-ai/dsh-subagent/lib/types/descriptor.d.ts`（agentProvider/agentModel/agentReasoningEffort）|
| 请求模型决策瀑布 | `@deepseek-ai/dsh-agent-loop/lib/index.js` `prepareRequest`（1127 行）|

---

## 七、实测复核（方案 B 已落地后的失败归因）

> 背景：方案 B（改 DSH 源码，见 §5.4）已实施并写盘（3 处改动，详见 `docs/patch-notes.md`）。
> 用户在 Web 端实测：**能切换（选择器出现、切换后界面显示新模型），但发出消息后既没有像主会话那样注入"模型切换"上下文，轨迹实际使用的仍是原模型。**

### 7.1 实测证据（一次真实的子代理会话记录）

| seq | 事件 | 内容 |
|---|---|---|
| 0 | subagent/descriptor | mode=continuable，agentProvider/agentModel = 创建时指定的路由 |
| 22/23 | model/selection | 用户切换后的新路由（含 reasoningEffort）— 切换写入成功 |
| 24 | session/end-seed | 冷恢复（resume）标志 |
| 25 | agent/inbox/spliced | 用户 follow-up |
| 26 | turn/start | turn 正常启动 |
| **31** | **request/header** | **reason="resume"，config 仍为创建时的旧路由** ← 未切换 |
| 32 | assistant/message | 子代理自述的仍是创建时的模型 |

对照：在补丁写盘之后启动的隔离实例，同一路径会话中先写入 `model/selection`（用户所选路由）→ 其后的 `request/header` 即为**新路由**，切换真正生效。

### 7.2 三层归因（现象与代码机制逐一对应）

| 现象 | 归因 | 重启能否修复 |
|---|---|---|
| **① 能切换（选择器出现 + 界面显示新模型）** | 前端 `dsh-client-ui-model-selection/lib/client.js` 补丁经 **HTTP 下发到浏览器**，不受 Node 模块缓存约束，刷新即生效；后端 `dsh-api-session-controller` 补丁**早于**进程启动即已加载，故 `model/selection` 事件写入成功 | — |
| **② 没有注入"模型切换"上下文** | **补丁设计如此，与进程新旧无关**：子代理路径用"精简安装"（`ensureModelSelectionInstalled` 只挂 `agent/request`），**从不注册** `agent/pre-step` → `modelSwitchNotice`；而主会话走 `controller.selectionFor` 的完整 `installModelSelection`（assemble+request+pre-step 三件套），才会注入 `[model changed: ...]` | **不能**（固有缺口） |
| **③ 轨迹仍用旧模型** | `dsh-subagent` 的两个文件是在**该进程启动之后**才写盘的 → Node ESM 启动时已缓存旧内容，运行时**不会**换新；该进程 HMR 也不覆盖 node_modules 核心包（`ignored: ['**/node_modules']`，框架级依赖改动只会走退出重启） | **能**（重启进程即可） |

补充：`coldResume` 中"读取用户 `model/selection` 覆盖 descriptor"的改动位于 `dsh-subagent`，正是 ③ 需要的部分；而未重启的进程没有这段逻辑，于是回落到 descriptor 的创建时路由。

**交叉验证（差分证据）**：补丁自带调试标记 `[model-switch]`（走 stderr）在"补丁写盘前已启动"的实例日志中计数 **0**；在补丁写盘之后启动的隔离实例日志中为 **2**（coldResume + install）。`[model changed` 文本在主会话中存在真实注入事件，在两个子代理会话中计数为 **0**。

### 7.3 对方案 B 结论的修正

1. **§5.4 方案 B 的"部分可行"成立**，但落地后必须补两条此前未写明的结论：
   - **"只有前端可热生效，后端改动必须重启进程"**：`dsh-client-ui-model-selection` 经 HTTP 下发可刷新即生效；`dsh-api-session-controller`/`dsh-subagent` 在进程启动时载入，改完必须重启才生效——这正是"能切换但轨迹没换"的直接原因。
   - **"模型切换通知在子代理路径是结构性缺失"**：不是"没生效"，而是补丁为避免"完整版 `installModelSelection` 破坏冷恢复子代理的 turn 启动"（已有二分实验证据）而刻意改用精简安装的**代价**。重启**不能**补齐；要补齐需另行处理（在子代理路径单独挂 `agent/pre-step` 通知，且不得引入导致冷恢复 turn 不启动的行为）。
2. **隔离实例验证 ≠ 真实环境可用**：该隔离实例成功只因它是"补丁写盘之后"启动的进程。
3. 另发现一处卫生问题（非功能缺陷）：`dsh-subagent/lib/types/continuation.js:72` 残留未使用的 `import { installModelSelection } from "@deepseek-ai/dsh-agent"`；该文件不是运行时入口（`main`/`exports["."]` 均指向 `lib/index.js`，其内联了同一份 continuation 逻辑），故不会造成运行时问题，可择机清理。
4. **验证方法学教训**：补丁写盘后必须在"新启动的进程"上验证；且应保留一条可观测标记（如隔离实例日志中的 `[model-switch]`）用于确认进程实际加载的版本——写盘前已启动的实例日志中该标记为 0，是定位 ③ 的决定性证据。

