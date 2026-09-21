# DSH 子代理会话模型切换补丁说明（0.1.5-rc.1）

> 目标：在 Web 打开可继续（continuable）子代理会话时，composer 出现模型选择器（复用主会话模型菜单），可手动切换该子代理所用模型。
> 性质：修改 DSH 安装包源码（node_modules），**升级会被覆盖**，需按本文重打。
> 备份：patches/backup-2026-09-15/
> 审查：历经两轮独立 subagent 对抗式源码审查——第一轮发现 2 HIGH / 2 MEDIUM / 若干 LOW 缺陷，已全部修复（见下方「修复记录」）；第二轮复核判定 **PASS**（无 blocker/high/medium 新问题）。
> 状态：**端到端验证成功（隔离实例）** = 选择器出现 + 切换写入 + UI 立即显示 + 激活后请求头使用新模型 + turn 正常 completed。
> **关键踩坑**：① dsh-subagent 实际加载 lib/index.js（内嵌 continuation 代码），改 lib/types/continuation.js 无效——修改必须落在 lib/index.js；② installModelSelection 完整版（含 agent/pre-step 模型切换通知）会破坏冷恢复子代理的 turn 启动，必须用"精简安装"（仅挂 agent/request 覆盖）；③ 验证时需选一个已配置 API key 的 provider，否则请求会失败

## 修复记录（两轮对抗式审查后的改进）

> 第一轮独立 subagent 审查发现补丁本体在 fork/live 边界路径存在缺陷，已全部修复；第二轮复核确认修复正确、无新引入的 blocker/high/medium 问题。

| 级别 | 问题 | 修复 |
| --- | --- | --- |
| HIGH-1 | 驻留刷新 `latestSubagentModelSelection(session.snapshotEvents())` 未剔除 fork 继承前缀，fork 子代理会误读父会话的 `model/selection` | 精简 overlay 改为每次请求实时读 `agent.session.ownEvents()`（剔除继承前缀），与 coldResume 的 `slice(inheritedEventCount)` 语义对齐 |
| HIGH-2 | 精简 overlay（内存 `current` 快照）与完整 `installModelSelection` 两套 selection 状态叠加，cold→resume→live 切换时陈旧快照覆盖新选择 | 精简 overlay 不再缓存内存快照，改为每次 `agent/request` 从 session 的 `model/selection` 事件实时读取（controller `selectForNextRequest` 写同一事件），两套机制收敛到唯一真相源 |
| MEDIUM-3 | `append/flush` 异常未包装 + `SessionOwnershipLostError` 捕获位置错位（写在 `open` 处，实际在 `append/flush` 抛） | `open` 只捕获 `SessionAlreadyOwnedError`；`append/flush` 新增 catch，将 `SessionOwnershipLostError`/`SessionAlreadyOwnedError`/`SessionHandleClosedError` 映射为 `session/agent-busy`，其余映射 `gateway/internal` |
| MEDIUM-4 | 精简 overlay 重建 config 时丢弃 `resolved` 除 maxTokens 外的字段 | 改为 `{ ...withoutInheritedEffort, provider, model, reasoningEffort? }`，与官方 `installModelSelection` 的 request 覆盖同构 |
| LOW-6 | `foldSubagentMode` 未剔除继承前缀（与 `foldSubagentDescriptor(ownEvents)` 语义不一致） | 三处调用改为剔除前缀（live 用 `ownEvents()`，cold 用 `slice(inheritedEventCount)`） |
| LOW-8 | `continuation.js` 未使用的 `installModelSelection` import | 删除 |

> 复核结论：**PASS**；仅余 1 个 low 级性能观察项（overlay 每次请求 O(n) 遍历 `ownEvents`，可后续改为增量 fold）。

## 一、改动文件（4 个文件 / 3 个包）

> 📌 **要复刻请直接看第五节**。本节的文字描述是摘要，其中第 3 条为实现细节的**旧版表述**，
> 与"关键踩坑②"不一致：实际实现是**精简安装**（`ensureModelSelectionInstalled`，只挂 `agent/request`），
> **不是** `installModelSelection`。以 `patches/*.patch` 为准。
> 各处精确行号（0.1.5-rc.1）：前端 23/336/953/957/961/978；controller 28/617-619/915/949；
> subagent 1627/1636/1672/1686/1884-1886/1973/2002。

### 1. @deepseek-ai/dsh-client-ui-model-selection/lib/client.js（前端）
- 新增 `subagentModelSelectable(sessions, sessionId)`（约 23 行）：普通会话恒可用；子代理仅 `address.mode === "continuable"` 可用（one-shot 与父离线视图由只读 composer 天然抑制，不渲染选择器）。
- 替换 4 处 `available` 判断（约 319/936/940/944/961 行）：`sessions.subagentAddress(id) === void 0` → `subagentModelSelectable(sessions, id)`。

### 2. @deepseek-ai/dsh-api-session-controller/lib/index.js（后端 selectModel）
- 新增 `foldSubagentMode(events)`（约 28 行）：取第一个 `subagent/descriptor` 的 mode。
- `selectModel`（约 605 行）：改走 `resolveAgentForModel`；返回 undefined 时调 `recordColdSubagentSelection` 记录模式。
- `resolveAgentForModel`（约 915 行）：
  - 普通会话 → 原 `resolveAgent` 结果；
  - **live 子代理**（`ctx.agents.get` 命中且 origin=subagent）→ 返回 agent（走 installModelSelection + waterfall，下一次请求换模型）；
  - **cold continuable 子代理且父 agent 在线**（inspectApiSession 读 header.origin + foldSubagentMode + `ctx.agents.get(parentSession)`）→ 返回 undefined（走记录模式）；
  - 其余（one-shot、父离线、非子代理出错）→ 原错误（session/agent-busy 等）。
- `recordColdSubagentSelection`（约 938 行）：校验 origin=subagent、mode=continuable、父 agent 在线 → `llm.resolveCallConfig` 校验路由 → `ctx.get("sessionPersistence").open(id,"write")` 读当前事件数、append `model/selection`（seq=events.length）、flush。**不写全局默认模型**（跳过 saveSelection）。

### 3. @deepseek-ai/dsh-subagent/lib/types/continuation.js（后端 coldResume）
- 新增 `latestSubagentModelSelection(events)`（约 81 行）：取最后一个 `model/selection` 事件。
- `coldResume`（约 338 行）：materialize 子代理后，若存在用户记录的选择（`selectedModel`），
  - agentOptions 用该选择覆盖 descriptor 的 provider/model/effort（作无持久化 header 时的基线）；
  - **并 `installModelSelection(childAgent.ctx, { current, consume: () => false, assembled: void 0 })`**，使下一次请求的 `agent/request` waterfall 覆盖 agent-loop 从持久化 requestHeader 恢复的旧模型（关键修复）。

## 二、实现语义

| 场景 | 行为 |
|---|---|
| 运行中（live）可继续子代理 | 切换 → selection 安装 → **下一次请求**用新模型（与主会话一致，持续保持） |
| cold 可继续子代理 + 父在线 | 切换 → 写入会话 `model/selection` 事件 → 下次激活（coldResume）用新模型 |
| 一次性子代理 | 前端选择器不出现；后端拒绝（mode≠continuable） |
| 父离线可继续子代理 | 只读 composer（无选择器），后续激活需父在线 |
| 主会话 | 行为不变（非 subagent 分支），默认模型照常保存 |

## 三、已验证（隔离实例，独立 DSH_HOME）

1. ✅ 前端：子代理会话视图出现模型选择器，菜单完整复用主会话模型列表（按 provider 分组）。
2. ✅ 后端切换：选择模型后会话写入 `model/selection` 事件（provider/model 为所选值），**选择器立即显示新模型（confirmed 乐观显示，无需刷新）**。
3. ✅ **激活生效链路（最终验证）**：切换后发 follow-up → coldResume 读到最新 model/selection → 精简覆盖安装 → **请求头使用新模型** → turn/end completed（正常回复）。
4. ✅ 语法检查：**4 个**改动文件 `node --check` 通过；隔离实例启动正常。

> **审查结论（subagent 只读审查）**：结论成立、证据链完整（选择事件 → 冷恢复 → 请求头 → 模型响应 → completed 全部对齐）、可放行；2 个清理项已处理（lib/types/continuation.js 残留完整版 installModelSelection + 诊断日志 → 已改精简版并移除日志；index.js 调试用 LOADED 日志 → 已移除）。

## 四、已知限制

- **仅 continuable 子代理可切换**：一次性子代理（不会再发请求）、父离线子代理（只读）不可切换（合理）。
- **live 子代理切换路径**（切换时子代理恰好 live）：`resolveAgentForModel` 返回 live agent → `selectForNextRequest → selectionFor` → 用**完整版** `installModelSelection`（assemble + request + **pre-step**），**应当**注入 `[model changed: ...]` 通知，与主会话一致。代码层判定安全，但 **至今未做 E2E 实测**（浏览器自动化环境不稳定），建议在真实环境实测一次 live 场景。
  ⚠️ 与下面的 cold 路径行为**不同**，勿混为一谈（详见下文"实测复核"末尾的路径区分）。
- **KV Cache**：切换模型后子代理会话既有前缀缓存失效（重算），fork 子代理尤其明显（官方因此限制 fork 选择；本补丁对 fork 工具创建的 continuable 子代理同样放行，可接受则保留）。
- **需重启 dsh 进程**才应用后端改动（前端文件改动已随浏览器刷新生效，后端进程需重启）。

### 实测复核（重要补充）

补丁写盘后、进程重启前的表现与归因（证据自洽、本文内已含判据；同内容亦见于 `docs/feasibility.md` 第七节）：

| 现象 | 归因 | 重启能否修复 |
|---|---|---|
| 选择器出现、切换后界面显示新模型 | 前端补丁经 HTTP 下发（刷新即生效）+ `dsh-api-session-controller` 补丁早于进程启动已加载 | — |
| 未注入 `[model changed: ...]` 通知（**cold 冷恢复路径**） | coldResume 用"精简安装"（`ensureModelSelectionInstalled` 只挂 `agent/request`），**不注册** `agent/pre-step`，与进程新旧无关 | **不能**（cold 路径固有缺口） |
| 轨迹仍用旧模型（request/header reason=resume 仍为 descriptor 模型） | `dsh-subagent` 补丁写盘晚于进程启动，Node ESM 已缓存旧模块；HMR 不覆盖 node_modules 核心包 | **能**（重启进程即可） |

> 判据：补丁的 `[model-switch]` 调试标记在写盘前已启动的实例日志中计数为 0、在补丁后启动的隔离实例中为 2；`[model changed` 文本在主会话有注入、在子代理会话为 0。

> ⚠️ **重要区分（勿混淆两条路径）**：
> - **live 路径**（切换那一刻子代理正活着）：`selectModel → resolveAgentForModel` 返回 live agent → `selectForNextRequest → selectionFor` → 用**完整版** `installModelSelection`（挂 assemble + request + **pre-step**）→ **应当**注入 `[model changed: ...]` 通知，与主会话一致。此路径**未有 E2E 实证**（缺 live 场景实测），代码层判定应出现通知。
> - **cold 路径**（先关/释放，之后才发消息）：走 `coldResume` 的**精简安装**，只挂 `agent/request`，**不会**有通知。
> 上表那一行的结论**只适用于 cold 路径**；不要把它当作"所有子代理路径都没有通知"。

另：`dsh-subagent/lib/types/continuation.js:72` 残留未使用的 `import { installModelSelection } from "@deepseek-ai/dsh-agent"`（该文件非运行时入口，无功能影响，可择机清理）。

## 五、复刻 / 重打方法（推荐：用下面的自动应用器，Windows 同样可用）

> ⚠️ 本文第二节的"改动说明"是**给人读的摘要**，且第 3 条与本文第 8 行"关键踩坑②"**自相矛盾**（摘要写"用 `installModelSelection`"，实际实现是"精简安装 `ensureModelSelectionInstalled`"）。
> **照摘要手改不可靠**。请用 `patches/` 里的机器可读补丁，它由"pristine npm 包 ↔ 已打补丁文件"的真实 diff 生成，已逐条验证。

### 5.1 目录内容

| 文件 | 作用 |
|---|---|
| `patches/01..04-*.patch` | 标准 unified diff（给人看 / 给 `git apply` 用） |
| `patches/hunks.json` | 同样的改动，结构化锚点（供应用器使用） |
| `patches/apply-subagent-model-patch.mjs` | **跨平台应用器（Windows/macOS/Linux 通用，纯 Node，无外部依赖）** |
| `patches/backup-auto/` | 应用器写入前的自动备份（`--revert` 用它还原） |

### 5.2 使用步骤

```bash
cd patches

node apply-subagent-model-patch.mjs --scan              # 1) 看机器上有哪些同名包副本、各自补丁状态
node apply-subagent-model-patch.mjs --check             # 2) 干跑：确认每个锚点都能唯一命中（不写盘）
node apply-subagent-model-patch.mjs                     # 3) 应用（自动定位 dsh 安装根；写前备份）
node apply-subagent-model-patch.mjs --verify            # 4) 验证"web profile 实际加载的那份"已打补丁
# 5) 重启 dsh 进程（后端模块只在进程启动时载入！）
node apply-subagent-model-patch.mjs --revert            # 需要时回滚
```

定位失败或要打别处时显式指定：`--dsh <dsh 包目录>`；验证别的 profile：`--verify --profile <profile 目录>`。

### 5.3 应用器已处理的坑

1. **多副本**：同名包在本机有十几份（全局安装 + `~/.dsh/profiles/node_modules` + 各 `.pnpm` 目录）。**改错副本等于白改**。`--scan` 列出全部及状态；`--verify` 用 Node 的解析规则确认 profile 真正加载的那份。
2. **换行风格（LF / CRLF / 混合）**：Windows 上 git autocrlf / 编辑器会把安装目录改成 CRLF，甚至只改一部分行（混合换行）。只按 LF 精确匹配会**全部失败**。应用器对每段锚点依次尝试"原文 / 全 CRLF / 换行无关正则"三种匹配；写出风格按**多数派**判定（CRLF 行数 > LF 行数才算 CRLF），避免"只有个别 CRLF 行却把新增内容整段写成 CRLF"从而引入混合换行。
   实测三种目标（纯 LF、纯 CRLF、混合换行）应用后与可用安装**逐字节一致**（忽略换行符差异）；可回滚。
3. **路径含空格/括号**：实测 `/tmp/win space (x86)/...` 正常。
4. **版本变化时不会写坏**：若因升级导致锚点改变，应用器会明确报错（含"锚点出现多次"的歧义检测）。
5. **全有或全无（原子性）**：应用器先在内存里规划全部 4 个文件，**任何文件失败就整体不写**（实测：伪造一个文件锚点失配后，其余 3 个文件保持未改动、备份目录为空、退出码 1）。
   **写入阶段的 I/O 失败也已兜住**：若写到第 N 个文件时出错（如权限不足、文件被占用），应用器会按逆序把**本次已写入的文件全部还原**再退出（实测：把第 2 个文件设为只读 → 第 1 个文件被回滚，最终 4 个文件全部保持 pristine，无"半打补丁"状态）。
6. **幂等**：已打补丁的文件自动跳过，可重复执行。
7. **备份按安装隔离**：备份写到 `patches/backup-auto/<安装键>/`，每个 dsh 安装一个子目录。否则先给 A 安装打补丁、再给 B 安装打时，B 的备份会被 A 的备份占用，导致对 B 执行 `--revert` 时还原成 A 的原始文件（实测已修复：两个安装各存 4 份备份，各自 `--revert` 后都精确回到各自 pristine）。
   另外：若备份已存在但**内容与当前文件不同**（属于另一次安装，或该文件在备份后被升级覆盖），应用器会**报错中止**而不是覆盖它——否则会得到错误的还原源。
8. **非运行时入口可选**：`dsh-subagent/lib/types/continuation.js` 不是运行时入口（`main`/`exports["."]` 都指向 `lib/index.js`，后者内联了同一份逻辑），打它只是为了让源码树自洽。该文件在 `hunks.json` 中标为 `optional`：**若未来版本删除了它，应用器只跳过并提示，不会让整次应用失败**。
9. **部分回滚的边界**：`--revert` 需要对应文件的备份存在；必需文件缺备份会整体中止（不会写半个回滚），可选文件缺备份则跳过。因此"只给部分文件打过补丁"的安装无法逐个回滚——请保持完整应用/完整回滚。

### 5.4 前置条件与手工重打

**前置条件**（缺一不可）：
- **Node ≥ 18**（应用器使用 ESM + 可选链；推荐与 dsh 同版本）。
- **先停止 dsh 进程**再应用，否则正在运行的进程可能仍在使用旧模块（且备份/写入可能被占用）。
- 工具包目录**必须可写**（应用器要在 `patches/backup-auto/` 写备份；放在只读位置会触发写入失败）。
- 确信打在了**正确的副本**上：用 `--scan` + `--verify`（见 5.3-1）。

**手工重打**（不用应用器时）：`node --check` 校验 **4 个** js 文件语法后重启 dsh；备份见 `patches/backup-auto/<安装键>/` 与 `backup-2026-09-15/`。

**验证补丁真的被加载**（重启后确认）：
```bash
# 后端加载标记（补丁内自带，走 stderr）——出现即说明新代码已生效
grep -c "\[model-switch\]" <dsh 的启动日志文件>
# 或在 dsh 启动日志中直接观察：切换子代理模型后应打印 coldResume/install 两行
```
> 日志位置随启动方式而异（前台运行即标准输出；后台/服务方式一般在用户日志目录下）。若该标记计数为 0，说明进程仍在跑旧模块，需重启。

## 六、跨平台可用性（Windows 能否生效）

**结论：能生效，且与本机平台差异无关。** 依据：

| 项目 | 说明 |
|---|---|
| 改动内容 | 四份 diff 的新增行**不含任何平台相关代码**（无路径常量、无 `process.platform`、无 `path.sep`、无 `require`/`__dirname`），全部是纯 JS 逻辑 |
| 换行符 | 安装包内是 LF；应用器已适配 CRLF（见 5.3-2）。直接手改时**不要**让编辑器转换整个文件换行 |
| 路径分隔 | 改动代码内部无路径拼接；目标路径由应用器用 `path.join` 处理 |
| 依赖 | 无需额外依赖，运行应用器只需 Node |
| 进程模型 | 与平台无关；**改完必须重启 dsh 进程**才生效（后端模块在启动时载入，HMR 不覆盖 node_modules 核心包） |
| 升级 | 每次 `npm update`/`pnpm` 重装都会被覆盖，需按第五节重打 |

### 6.1 Windows 上仍需注意的两点

1. **副本选择**：Windows 上用 npm 全局安装时，真正的加载路径通常是 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\...`；但 profile 目录（`%USERPROFILE%\.dsh\profiles\web\...`）下可能另有 `.pnpm` 副本。**务必先 `--scan` + `--verify`**，应用器已内置这些 Windows 常见全局路径的自动探测。
2. **符号链接权限**：dsh 为 profile 建立回退链接（`~/.dsh/profiles/node_modules`）时，在 Windows 上走 junction（`symlinkSync(...,'junction')`），无需管理员权限。若目录被手工改成普通目录，dsh 会明确报错而不是静默错用。

### 6.2 未覆盖的场景（诚实说明）

- **pkg 打包的可执行文件**（`process.pkg`）：此时 dsh 用 "module proxy" 在 profile 内转发模块，**改安装包源码不生效**（没有可改的真实文件）。若你的 Windows 用的是打包版 dsh 可执行文件，本补丁方案不适用，需改用插件方案（见调研报告 §5.4 方案 A）。
- 未在 Windows 上做真实端到端运行验证：上述结论来自"改动内容零平台耦合 + 换行/路径/副本三类风险的实测模拟"。首次在 Windows 落地时，建议先 `--check`，应用并重启后用 5.4 节的 `grep "[model-switch]"` 方式确认加载版本。

## 七、相关文件
- 备份（首次手工改动时）：patches/backup-2026-09-15/{ui-model-selection.client.js.bak, api-session-controller.index.js.bak, api-session-controller.agent.js.bak}
- 复刻工具：patches/（diff + hunks.json + 应用器 + 自动备份）
- 测试实例建议：用独立 `DSH_HOME` + 独立 profile 起第二个 dsh 实例（换端口），并在启动环境中提供所选 provider 的 API key，避免影响正在使用的那个实例。
