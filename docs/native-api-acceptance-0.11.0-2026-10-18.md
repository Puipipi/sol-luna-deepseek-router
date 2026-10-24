# Native API 0.11.0 验收矩阵（2026-10-18）

本文是 0.11.0 candidate 的逐项验收骨架，不是发布声明，也不修改既有
0.10.5 历史记录。状态分为：`0.10.5 已验收`、`Node/模拟已验证`、
`待真实 0.11 桌面验收`、`部分`、`限制/未验证`。只有带真实桌面或真实 CI
证据的状态才会写成已验收。

## 基线与证据边界

- 0.10.5 原生 DeepSeek 桌面证据：
  [desktop acceptance](native-desktop-acceptance-0.10.5-2026-10-18.md)。
- 0.10.5 组成证据还包括
  [formal install](native-formal-install-2026-10-18.md)、
  [stable gateway](native-stable-gateway-acceptance-2026-10-18.md)、
  [formal fault](native-formal-fault-acceptance-2026-10-18.md)、
  [multi-chat](native-real-multichat-acceptance-2026-10-18.md)、
  [live route/hook](native-live-route-hook-acceptance-2026-10-18.md) 和
  [real 401](native-real401-acceptance-2026-10-18.md)。
- 0.11 API 后端说明：
  [native-api-executors](native-api-executors.md)。
- MCP 面板与服务工具：
  [router settings MCP](router-settings-mcp.md)。
- 公开普通 Node Tests：run `39136777449`，head `895d05e`，
  Linux `route` 与 Windows `windows-helper` 均成功；
  [run](https://github.com/Puipipi/sol-luna-deepseek-router/actions/runs/39136777449)。
- stack-test 集成 `0a04684` 已包含在 `895d05e`，上述公开 CI 覆盖该代码；
  本文新增验收记录仅运行 `docs.test`，不将文档新增等同桌面验收。
  0.11 尚未正式安装。
- 当前 Rust patch 为 `2a5d6310c76b992ef772e62410c593204b570ff20f6e8a967f43deeac42bc3e7`
  （109095 bytes）；四个 large-fixture 测试使用同名 `#[test]` wrapper +
  `async_impl` 和 pinned `run_test_with_large_stack` 8 MiB，测试 body、
  八项计数和断言不变，production 仍为 16 MiB。
- Rust 构建 run `39136590575`，head `1155c51`，ref
  `fix/native-deepseek-bounded-retries`：wire 与旧 native DS 测试已通过，
  native API profile tests 失败；run 最终 completed FAILURE、cache SUCCESS，
  running 8 中两项轻测试通过，none cold-resume 与
  `prepare_agent_spawn_config` 两项均 `STATUS_STACK_OVERFLOW`，没有 release
  artifact。不能写 GREEN，也不能声称新 binary 已存在。
- 旧 run `39134187187` 也失败于 none cold-resume
  `STATUS_STACK_OVERFLOW`；失败记录不能被后续文本覆盖。第四次 run 为
  run `39138841194`，head
  `45a3bd343c4bf4fc99115e7d68ee74d685429c01`，ref
  `fix/native-deepseek-bounded-retries`：native API 8 项全部跑完，7 项
  passed、1 项 failed；唯一失败是 none cold-resume fixture 使用非法原生
  `task_name`（`non-reasoning-worker`），large-stack 修正已解决先前栈问题，
  后续修正改为 `non_reasoning_worker`。该 run 已 completed FAILURE、cache
  SUCCESS，没有 release artifact binary。第五次、也是唯一新 corrective
  dispatch 为 run `39140584735`，head
  `51381b729d383beab91e778a6639f907e2f9ba7b`，branch
  `fix/native-deepseek-bounded-retries`，当前 `in_progress`，不能写 GREEN。

## 原目标八组

| # | 要求 | 状态 | 直接证据 | 下一实际动作 |
| --- | --- | --- | --- | --- |
| 1 | Sol 主控上下文、主连接与未来主模型兼容 | 0.10.5 已验收；0.11 待复核 | 0.10.5 桌面记录：完整重启后 parent identity 保持，实际 parent rollout 与 global default 可不同，root provider/base/catalog override 未引入；route/catalog 单测 | 新 runtime 安装并完整重启后复核 parent provider/context 不变 |
| 2 | 默认峰 Luna / 谷 DeepSeek，手动选择优先且 hook 不唤醒空闲 chat | Node/模拟已验证；0.10.5 hook/route 已观察 | route/hook 测试、0.10.5 desktop 双 chat 与 hook 记录 | 0.11 新 runtime 重启后确认新 chat 路由，不重复 human 观察 |
| 3 | 原生 DS child 显示、工具卡、同 child 追问、完整重启后历史 | 0.10.5 已验收，限 DS | 0.10.5 desktop：第 4 轮回顾、工具卡与输出展开匹配；同 child follow-up | 0.11 仅验证新 API role 的对应行为 |
| 4 | 连接隔离、失败明确、readiness 恢复、无静默 fallback | 0.10.5 DS 已验收；API 待验收 | 0.10.5 fault/desktop、transport fault tests、API gate tests | 新 API role 故障路径实测；OS 自动 Task restart 仍不作保证 |
| 5 | DSH 账号/凭据分离、真实 API 使用、parent usage 与 relay | 0.10.5 DS 已验收；generic API 未验收 | 0.10.5 usage 记录；settings/credential 测试；generic MiMo 尚无已配置凭据 | 配置一个真实 API credential 后做显式 API probe；不读取/打印 key |
| 6 | 多 chat、偏好、writer ownership、隐藏窗口、中文 | 0.10.5 DS 已验收；API readonly 绑定 Node 已验证 | 0.10.5 双 chat/lease/hidden launcher；`native-state` record/complete/bind 测试 | 0.11 API child 的真实多 chat/写 lease 验收 |
| 7 | 唯一 skill、名称、版本/docs、回滚、插件/公开发布 | 部分 | 单一 canonical skill；0.10.5 rollback fixtures；0.11 metadata 与 public Node run | root 发布前完成安装/升级、最终 CI 与 release 记录 |
| 8 | 真实桌面结果、可观察限制、非模拟声明 | 0.10.5 已验收；0.11 未验收 | 0.10.5 desktop 记录；0.11 当前只有 Node/模拟 | 新 runtime 安装、完整重启、真实 native API child 桌面验收 |

## 扩展需求

| 要求 | 状态 | 直接证据 | 下一实际动作 |
| --- | --- | --- | --- |
| DSH 自动账号凭据，失败不试探其他账号/供应商 | Node/模拟已验证；0.10.5 DS 账号路径已观察 | settings/credential 测试、0.10.5 usage；错误路径保留 generic 错误 | 0.11 新 runtime 下用真实 DSH account 验证一次 |
| 手工 API env/file refs，无值与无回退 | Node/模拟已验证；真实 MiMo 未验证 | settings credential/key-file tests、router settings credential check | 配置用户拥有的真实 API ref 后验证；未配置时明确失败 |
| 单个非 DS API 使用 fixed，不读取峰谷时钟 | Node/模拟已验证 | route tests：fixed 不调用 calendar；API gate/task tests | 新 runtime 下实测 fixed API child |
| scheduled 峰/谷两个 API 或 API+DS 组合 | Node/模拟已验证 | route calendar 与 scheduled 选择测试 | 新 runtime 下实测两种显式组合 |
| 一次性/sticky 显式选择优先于自动计划 | Node/模拟已验证 | route precedence tests；0.10.5 DS 手动选择记录 | 0.11 API 一次性选择与 sticky 实测 |
| 不可变 child profile、同 child 续问、冷恢复 | Node/模拟已验证；API 真实桌面待验收 | `native-state` binding/record/complete、install/reapply tests、0.10.5 DS 冷恢复 | 使用新 API role 做 spawn→binding→follow-up/冷恢复 |
| API child 的 profile/model/role/provider 不可晚覆盖 | Node/模拟已验证 | `native-state` immutable/late-binding tests | 在真实 API child 上重复绑定检查 |
| parent provider 与 API child 独立，不改 Sol 主连接 | 0.10.5 DS 已验收；API 待验收 | 0.10.5 root/provider 记录、API provider/artifact tests | 新 API child 的 rollout/provider 元数据核对 |
| 官方 DS effort：none/low/high/max；xhigh→high、max 保留 | Node/模拟已验证；真实 API role 未验收 | settings/protocol tests；官方 create-response/chat-completion/thinking-mode 文档 | 新 runtime 下检查实际 DS API request；none wire 语义按官方实现 |
| MCP 侧边栏 save/Apply/CAS，保存不等于安装 | Node/stdio UI 测试已验证；宿主侧栏未 human 确认 | `plugin-router-settings` 212、`plugin-mcp` 173、router guide | 打开真实侧栏，确认保存、Apply、stale CAS 与重启提示 |
| API Task 仅按需启动、隐藏、无多余 logon trigger | Node/模拟已验证；DS 0.10.5 hidden 已观察；API 实装待验收 | demand-only Task/policy tests、0.10.5 hidden launcher | 真实安装后检查 API Task trigger/隐藏/VBS |
| 回滚恢复共享 Task/launcher origin，A/B 任意顺序 | Node/模拟已验证 | `native-api-origin` 21、install rollback tests | 升级安装后做 owned rollback/恢复；保留 6ec 与 journal |
| 唯一 skill/plugin、稳定 registry/目录、公开发布 | 部分 | metadata、marketplace、single-skill docs、public Node run | root 合一发布，确认 registry 不出现两个 enabled skills |
| 升级可 adopt managed 旧 journal；先完成 DS workers 再 owned stop 旧 gateway | 待真实 0.11 验收 | installer journals/rollback docs；当前未执行真实升级 | 按 root 顺序：停止 DS worker→owned stop→adopt/new install |
| 保留 6ec 与新 journal 的回滚路径 | 待真实 0.11 验收 | 0.10.5 install/runtime records、installer rollback tests | 安装前保留旧 runtime/journal，验证可回滚 |
| 设置保存一次完整重启：save_profile + CAS | Node/模拟已验证；真实桌面待验收 | router settings save_profile/CAS tests、API guide | 通过同一设置 service 预存 save_profile+CAS 并 Apply，随后统一完整重启；再由 human 验证侧栏 |

## 真实 API role 的待验收项

以下项目必须由 0.11 新 runtime、新 role、完整 Codex 重启和真实桌面 child
共同证明；Node 测试、MCP mock、0.10.5 DS 历史或 adapter smoke 都不能替代：

- `native_api_<24hex>` role 是否被宿主发现，实际 `spawn_agent` 是否只传
  `task_name`、`agent_type`、`fork_turns: none`、`message`，且明确 omit
  `model`。
- provider/catalog/context window 是否按 immutable profile 生效；旧 child
  是否继续使用旧 profile，而不是最新 global plan。
- fixed API、scheduled 两个 API、一次性/sticky 选择及不静默 fallback。
- API Task 隐藏启动、health、无多余 trigger、owned rollback 与冷恢复。
- MCP 侧栏由真实人类确认保存、Apply、CAS 冲突、重启提示和 side panel 显示。
- 真实 MiMo 或其他非 DS API 的认证/错误/超时；当前没有已配置的 MiMo 凭据，
  因而此项只能是未验证，不能把本地 adapter 成功当真实 API 成功。

## Adapter smoke 的准确边界

`tests/native-api-cli-smoke.mjs` 的 286、416、484、571 行走的是私有
`CODEX_HOME` 与 `local_smoke` 根 provider 的 API adapter 路径，494 行是
普通 CLI resume；它们刻意不包含 `native_api_` role 或 `spawn_agent`
断言。因此这些三场景通过只能证明 adapter/CLI 组合，不证明 0.11 原生 API
role 桌面可用，也不能替代上面的真实 API role 验收。

## 结论边界

0.10.5 的 DeepSeek 桌面、工具卡、完整重启、故障 readiness 恢复、双 chat、
hidden launcher 与 lease 行为有既有历史证据；0.11 的 generic API 目前是
candidate。0.11 尚未正式安装，MCP 侧栏尚无 human 确认，MiMo 实际 API 尚无
已配置凭据。Rust run `39136590575` 已 completed FAILURE（cache SUCCESS，
无 release artifact），不能写 GREEN；旧失败 `39134187187` 不能改写成成功；
第四次 run `39138841194` 已 completed FAILURE/cache SUCCESS，8 项 API 结果为
7 通过、1 个 fixture 命名失败；第五次 run `39140584735`（head `51381b7`）
当前 in_progress，不能提前写 GREEN。本文不包含内部 token、
local gateway URL、temporary journal 路径、完整 journal 或任何密钥。
