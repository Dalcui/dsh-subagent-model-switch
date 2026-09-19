# dsh-subagent-model-switch

在 DeepSeek Harness (DSH) 的 **Web 界面里，为「可继续（continuable）子代理会话」手动切换模型**。

主会话早就能在输入栏切换模型，子代理会话不行——DSH 在前后端都刻意禁用了它（所有权边界 + KV Cache 前缀复用考虑）。
本仓库给出一份**已实测可用**的最小改动补丁，把子代理会话的模型切换打开。

> ⚠️ **性质**：直接修改 DSH 安装包源码（`node_modules`），**dsh 升级后会被覆盖**，需要按本文重新打补丁。
> 如果你更希望"不改核心源码"，请见 [docs/feasibility.md](docs/feasibility.md) 的方案 A（插件实现）。

> 📁 **仓库内容**：本仓库只包含补丁本体与文档，共 12 个文件（`README.md` / `LICENSE` / `package.json` /
> `.gitignore` / `docs/` / `patches/`）。应用器生成的备份目录（`patches/backup-auto/`）不入库。

---

## 一、效果

| 场景 | 行为 |
|---|---|
| 运行中（live）可继续子代理 | 切换 → 下一次请求即用新模型（与主会话一致） |
| 已释放（cold）可继续子代理 + 父会话在线 | 切换先落盘，下次激活该子代理时用新模型 |
| 一次性子代理（one-shot） | 不显示选择器（它不会再发起请求） |
| 父会话离线时的子代理 | 只读视图（无选择器） |
| 普通主会话 | 行为不变 |

---

## 二、快速开始

需要 **Node ≥ 18**。

```bash
git clone https://github.com/Dalcui/dsh-subagent-model-switch.git
cd dsh-subagent-model-switch/patches

node apply-subagent-model-patch.mjs --scan     # 1) 看本机有哪些同名包副本、各自补丁状态
node apply-subagent-model-patch.mjs --check    # 2) 干跑：确认每段锚点都能唯一命中（不写盘）
node apply-subagent-model-patch.mjs            # 3) 应用（自动定位 dsh 安装根；写前自动备份）
node apply-subagent-model-patch.mjs --verify   # 4) 确认 web profile 实际加载的那份已打补丁
# 5) 重启 dsh 进程（后端模块只在进程启动时载入！）
node apply-subagent-model-patch.mjs --revert   # 需要时回滚
```

定位失败或要打别处时：`--dsh <dsh 包目录>`；验证别的 profile：`--verify --profile <profile 目录>`。

**重启后如何确认补丁真的生效**：切一次子代理模型，然后在 dsh 日志里找补丁自带标记

```bash
grep "\[model-switch\]" <dsh 的启动日志文件>
```

出现 `coldResume` / `install` 两行即说明新代码已加载；计数为 0 说明进程还在跑旧模块，需重启。

---

## 三、目录结构

```
patches/
  01-client-ui-model-selection.client.js.patch    # 前端：放开子代理会话的模型选择器
  02-api-session-controller.index.js.patch        # 后端：selectModel 放行子代理
  03-subagent.index.js.patch                      # 后端：coldResume 用记录的选择覆盖描述符
  04-subagent.types-continuation.js.patch         # 后端：非运行时入口的同步副本（optional）
  hunks.json                                      # 结构化补丁锚点（应用器据此工作）
  apply-subagent-model-patch.mjs                  # 跨平台应用器（Windows / macOS / Linux）
docs/
  patch-notes.md                                  # 补丁说明：改动、语义、已验证、限制、复刻方法
  feasibility.md                                  # 可行性调研：DSH 的机制、为什么官方不提供、三条路线
```

---

## 四、应用器做了什么

这不是"按文档手改"，而是**由 pristine npm 包与已打补丁文件的真实 diff** 生成的机器可读补丁。应用器已经处理了手工打补丁最容易踩的坑：

- **多副本**：同一台机器上同名包可能有十几份（全局安装、`~/.dsh/profiles/node_modules`、各 `.pnpm` 目录）。**改错副本等于白改**。`--scan` 列出全部，`--verify` 用 Node 的解析规则确认 profile **实际加载**的那份。
- **换行风格**：纯 LF / 纯 CRLF / 混合换行都能正确匹配与写出（Windows 上 git `autocrlf` 的常见结果），不引入混合换行。
- **版本变化时不会写坏**：锚点找不到或出现多次时**明确报错**，而不是乱写。
- **全有或全无**：先规划再写入；任何文件失败则整体不写。写入阶段遭遇 I/O 失败（权限、占用）会**按逆序回滚**已写文件。
- **备份隔离**：备份按安装根散列存放，多个安装互不串号；备份内容与当前文件不一致时拒绝覆盖。
- **幂等 + 可回滚**：重复执行安全；`--revert` 还原。

---

## 五、Windows

**可以生效**，且与平台无关：补丁新增行不含任何平台相关代码（无 `process.platform`、无硬编码路径），应用器是纯 Node、零依赖。测试覆盖了 CRLF/混合换行、多副本、含空格与括号的路径。

两个前提：

1. **必须是 npm 安装版 dsh**。若你用的是 pkg 打包的独立可执行文件，dsh 会用 "module proxy" 转发模块，**没有真实源码可改，本方案不适用**。
2. **改完必须重启 dsh 进程**。

> 诚实说明：Windows **真机端到端未实测**，上述结论来自"改动零平台耦合 + 三类风险实测模拟"。首次落地建议 `--check` → 应用 → 重启 → 用上面的 `grep` 验证。

---

## 六、已知限制

- **仅可继续（continuable）子代理可切换**，一次性子代理与父会话离线场景不可切换（合理）。
- **模型切换通知**：cold 路径（子代理已释放后再激活）**不会**注入 `[model changed: ...]` 通知——这是为规避"完整版安装会破坏冷恢复子代理的 turn 启动"而付出的代价；live 路径走完整安装，**应当**有通知，但尚无端到端实证。详见 [docs/patch-notes.md](docs/patch-notes.md)。
- **KV Cache**：切换模型会让该子代理既有前缀缓存失效（需重算），fork 子代理尤其明显——这也正是官方限制 fork 选择的原因。
- **升级即失效**：`npm update` / 重装会覆盖改动，需重打。

---

## 七、来源与验证

本补丁源于一次完整调研 + 多轮独立审查（均由独立 subagent 执行源码级只读核验）：

- 端到端实测：选择器出现 → 切换写入 `model/selection` → 界面即时显示 → 激活后 `request/header` 使用新模型 → turn 正常完成。
- 复刻工具经过三轮独立审查，修复并复验了 3 个高危缺陷（写入期原子性、备份跨安装串号、换行判定过宽）。
- 三种换行目标（LF/CRLF/混合）应用结果与原安装**逐字节一致**，可回滚。

---

## License

MIT
