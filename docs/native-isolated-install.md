# 隔离 CLI 安装编排

## 0.10.5 bounded retry 候选

0.10.5 候选为专用 `native_deepseek` 子代理在角色配置中关闭 `unbounded_connection_retries`，保留 Sol/root 与其他角色的默认行为。配置与回滚 fixture 已覆盖复用既有 gateway/Task 时的 role 更新和字节恢复。patched CLI 已通过 Windows GREEN 构建并在一台主机安装、激活及完整退出重启后观察到；[后续桌面记录](native-desktop-acceptance-0.10.5-2026-10-18.md)列出实际范围和仍未完成的目标矩阵。0.10.4 的安装和桌面验收记录仍只描述当时已安装版本。

## 0.10.4 发布说明

0.10.4 将 gateway 五脚本绑定到 `native-isolated` 下的内容寻址 bundle，使受管 Task 的后续启动不依赖会被插件刷新清理的 cache；停止网关时按已验证的 PID/身份确认进程退出，不能仅凭 `Stop-ScheduledTask` 成功推断 Node 已结束。配置回滚会先验证受管 provider、role 三表及 gateway identity 仍与本事务一致，并拒绝会使 root provider 或 root URL 依赖该隔离 provider 的配置；通过后只移除本插件受管表，保留当前其他配置原文。受管字段漂移仍会拒绝回滚。此版本说明源码行为与回滚边界，不代表正式 Task 故障验收或桌面/UI 验收已通过；这些仍待单独验证。

`native-isolated-install.mjs` 提供 `prepare`、`activate`、`rollback`、`status` 源码入口，并由 mock 测试覆盖。它将已验证的 CLI、child-only 配置、三项受管环境变量、独立网关目录、Task Scheduler 任务和旧受管 Startup VBS 作为一个可审计事务编排。一次正式安装已在单一主机通过，详见[主机安装记录](native-formal-install-2026-10-18.md)；其他主机仍须本地核验，桌面验收仍待完成。第三项 `SOL_LUNA_NATIVE_INSTALL_JOURNAL` 保存本事务 journal 的绝对路径，供之后新建的 DeepSeek child 使用。

`prepare` 要求显式路径、当前主模型/provider（provider 可为 `null`）和 root URL 预期（可为 `null`），并要求 `--gateway-script` 或 `--plugin-root` 指向正式安装位置。使用 `--plugin-root` 时，prepare 将五个固定 gateway 模块写入 `gateway-dir` 的父目录下 `gateway-source/<content-digest>`（标准布局即 `native-isolated/gateway-source/<content-digest>`），并在 journal 中记录 bundle manifest hash 与 source root；因此该路径由明确的 `gateway-dir` 决定，不依赖 runtime 版本目录的布局。之后 Task 直接使用该稳定脚本路径，不再依赖可能被插件刷新清理的版本缓存。bundle 是不可变内容地址目录，完全匹配才会复用，缺失、额外文件、reparse point 或 hash 不一致都会拒绝。显式 `--gateway-script` 继续使用给定文件，不复制其父目录或依赖；调用方须自行保证其相对模块和生命周期稳定。旧 journal 没有 bundle 引用时保持原行为，不会由 dispatch 自动迁移。若旧 role/catalog 残留需纳入迁移，必须显式传入 `--legacy-manifest-path` 指向经验证的旧安装 manifest；工具不会自动发现或认领未知文件。它只准备私有网关身份，不启动服务；随后在临时 Codex home 上运行只读 app-server smoke。临时配置复用完整模型缓存并将 root catalog 指向临时缓存，正式配置仍保持用户主模型/provider/catalog。若迁移旧共享配置，smoke fixture 使用 legacy manifest 恢复旧 root 值。只有 smoke 返回 `status=passed` 才会写入 journal。

### 已激活安装的 gateway source 迁移

对没有 `gateway.sourceBundle` 的 active version 1 journal，可显式运行以下命令，将**下次 Task 启动**使用的脚本重绑到 journal 所属 runtime root 下的不可变五脚本 bundle：

```powershell
node .\scripts\native-gateway-source-migrate.mjs `
  --journal-path "<absolute-active-journal-path>" `
  --plugin-root "<absolute-installed-plugin-root>"
```

迁移要求当前受管 Task 已 Running 且 gateway health 严格报告 `deepseek_only=true`、`relay_allowed=false`；active source、plugin root 和新 bundle 中五个固定脚本必须逐字节完全一致。迁移只改 launcher 的唯一 gateway-script 路径及 journal，不停止或启动现有 gateway、不修改/重新注册 Task，也不触碰 Codex 配置或环境。health 检查沿用 gateway 现有实现，可能读取本机已有凭据；迁移本身不发模型/API 请求，也不直接复制、修改或输出凭据。

普通捕获到的写入失败会在 launcher/journal 仍精确匹配本次 from/to bytes 时恢复原始 launcher 和 journal，并保留私有原始 journal 备份；不删除已完成的 source bundle。若进程硬终止，可能遗留 `gateway_source_migrating` journal 或 migration lock。当前没有自动恢复入口：应先检查私有备份、journal、launcher 与 lock 的字节状态；不得盲目删除 lock 或重跑迁移。只有确认它们属于同一失败迁移并完成审查后，才可规划恢复步骤。此命令只重绑未来启动路径；必须另行完成 Task 启动后、确认新进程来源于稳定 bundle 的验收，不能仅凭迁移成功断言服务已切换。

smoke 完成后，`prepare` 仅对路径校验通过的本次临时 fixture 删除执行有界 EBUSY 重试：最多 10 次、间隔参数 350 ms，Node 的线性退避总等待上限为 19.25 秒；这不是整个 `prepare` 的硬超时。最终删除仍失败时，`prepare` 保留安全诊断并阻止写入 journal。

`activate` 首先重验 runtime、文件、事务中的环境快照、旧受管 Startup VBS、任务快照和 launcher。之后按顺序写入隐藏同步 VBS launcher、注册或验证精确匹配的当前用户 Task Scheduler 任务、启动并检查独立 gateway，再删除旧受管 Startup VBS，最后应用 Codex 文件与环境变量。Task 使用当前交互用户、Limited 权限、IgnoreNew、隐藏运行且无执行时限；它调用正式安装目录的 `native-gateway.mjs --serve --deepseek-only`。严格模式只接受 DeepSeek 模型，拒绝 GPT/未知模型和加密协作输入，并强制关闭 GPT relay；它不会要求或伪造 GPT 登录成功。dispatch gate 还要求健康响应明确报告 `deepseek_only=true`、`relay_allowed=false`，且受管 Task 状态为 `Running`，因此旧的非严格网关不能满足正式路径。普通 direct/legacy 网关仍保留旧兼容行为。不创建 DSH 会话或工作区。激活失败会尝试按本事务快照恢复；若任何阶段恢复不确定，会将 journal 标为 `activation_recovery_failed` 并列出阶段。

`rollback` 先检查所有受管值仍等于本事务写入内容，再恢复文件、环境、Startup、任务和 launcher。它只会在网关由本事务启动且当前 PID、身份与健康检查仍匹配时停止网关；既有受管任务/网关会保留。用户后续修改会导致回滚拒绝覆盖。成功迁移时，journal 的 `autostart.retiredLegacy` 单独记录旧受管 Startup 是否已退役；因此即使 root config 已无旧 marker、但 manifest 证明存在旧 role/catalog 残留，成功 rollback 也不会重建旧 Startup。此标记不扩大 `files.legacyMigration`。激活失败发生在旧安装退役完成前，仍逐字恢复 prior Startup。旧 journal 未包含该标记时，rollback 仍按旧 `legacyMigration` 判断兼容行为。迁移事务还保留两种配置快照：激活失败时恢复原始字节；用户主动 rollback 时恢复经过 manifest 验证的 `prior_root` 干净配置并移除隔离配置。`prior_root` 若本来就是用户的 localhost 设置，则按原值保留。首次安装无 config 迁移时，config 文件仍逐字恢复 prior；已退役的受管 Startup 不恢复。缺少迁移卸载快照的旧 journal 会在更改状态前明确拒绝卸载。`status` 的 `configured=true`、`restartNeeded=true` 只表示配置已写入并需要重启；`runtimeObserved=false` 和 `desktopAccepted=false` 是该静态 journal/status 输出的值，不会随桌面启动后被回写为最新运行事实。它们仍是桌面验收前的保守诊断；本机后续只读运行观察见[桌面验收记录](native-desktop-acceptance-0.10.5-2026-10-18.md)。需将实际桌面验收与配置 smoke/task health 分开判断。

配置合并只识别精确的三个受管 TOML 表。dispatch 与 rollback 均要求这三表、role 路径及 gateway identity 与事务计划匹配；受管字段漂移会被拒绝。rollback 还会拒绝 root provider 或 root URL 依赖隔离 provider 的情形。验证通过后，rollback 仅删除本插件受管表及 marker，保留当前其他 TOML 配置（包括后来新增的 skills、MCP、设置和外部注释）原文；这不放宽对受管字段或 root 路由依赖的检查。

后续稳定 source binding 与实际 Task source-switch 的主机记录见[稳定网关验收](native-stable-gateway-acceptance-2026-10-18.md)；部分 Task 故障与本机 TCP 结果见[故障验收记录](native-formal-fault-acceptance-2026-10-18.md)。后者明确区分通过的恢复/transport 场景与尚未通过的自动 Task restart，不代表完整故障矩阵或桌面验收。稳定记录所述主机当前 Task 已指向 `native-isolated` 下的内容寻址 bundle，不再从 0.10.2 或 0.10.3 plugin cache 加载 gateway 模块；五个 bundle 文件与 0.10.3 插件源码逐字节一致。此结论仅适用于该主机的当前 Task，不能单独作为删除旧 cache 的依据。root Sol 配置连接和已暂存 runtime 文件未变。HKCU 计划值均匹配，但仍运行的 CLI 进程继承值未刷新；未来新 chat 继承环境前仍须完全退出并重启 Codex。该记录不代表 desktop acceptance。

该主机的 0.10.4 插件包更新快照见[0.10.4 package 更新记录](native-plugin-update-0.10.4-2026-10-18.md)及其[结构化回执](native-plugin-update-0.10.4-2026-10-18.json)。它记录插件包/standalone skill 同步与安装时环境快照；不替代用户后续完整重启后的运行时和桌面验收。

所有命令均要求显式路径；以下值是占位符，不含凭据。主模型/provider/URL 应填写当前实际值，不要将包含凭据的 URL 写入 shell 历史、journal 或任务参数。`--plugin-root` 应是正式安装目录，不能指向工作区源码目录。

```powershell
node .\scripts\native-runtime.mjs stage `
  --artifact-dir "<build-artifact-directory>" `
  --companion-dir "<stock-codex-bin-directory>" `
  --runtime-dir "<private-runtime-root>"

node .\scripts\native-isolated-install.mjs prepare `
  --version-dir "<staged-version-directory>" `
  --codex-home "<codex-home>" `
  --gateway-dir "<new-private-gateway-directory>" `
  --plugin-root "<installed-plugin-root>" `
  --startup-dir "<user-startup-directory>" `
  --journal-path "<private-journal-path>" `
  --expected-main-model "<current-main-model-slug>" `
  --expected-main-provider null `
  --expected-root-base-url null

# When old role/catalog files must be included, pass the verified manifest explicitly:
#   --legacy-manifest-path "<verified-old-install-manifest>"

node .\scripts\native-isolated-install.mjs status --journal-path "<private-journal-path>"
node .\scripts\native-isolated-install.mjs activate --journal-path "<private-journal-path>"
node .\scripts\native-agent.mjs --executor deepseek --json
```

第一阶段只暂存 CLI 和 companions。第二阶段准备隔离配置、smoke 与事务快照，不写正式配置、不改环境、不注册任务、不启动 gateway。第三阶段才应用配置并注册独立任务；成功后完全退出并重新启动 Codex，使后续新 chat 继承更新后的 HKCU 环境。已运行的 Codex 不会自动刷新该环境。每次 DeepSeek dispatch 前，`native-agent.mjs` 优先使用显式 `--install-journal`，否则读取 `SOL_LUNA_NATIVE_INSTALL_JOURNAL`，并用该 journal 验证任务、配置与 gateway health；缺失或异常时明确失败，不会扫描其他位置、自动注册、直启、调用 DSH 或重放任务。Luna 继续使用当前模型缓存解析模型，不经过此 gateway。

当前主路由的 ordinary task routing 不运行安装命令，也不会自行修改全局配置、环境变量、计划任务或重启桌面。用户明确要求 setup/activate 时，不重复要求授权。普通协作使用原生 Codex child；DSH MCP 仅供用户显式选择的 legacy 工作流，且不会创建原生 Codex child session。

如需撤销本事务且受管状态未被后续修改：

```powershell
node .\scripts\native-isolated-install.mjs rollback --journal-path "<private-journal-path>"
```

journal 使用 base64 保存原始 Buffer 快照；Windows 文件访问继承父目录 ACL，本模块不更改 ACL。准备/配置和桌面生效是不同阶段；其他主机须独立核验，且任何已配置状态都不等于桌面接受验收。
