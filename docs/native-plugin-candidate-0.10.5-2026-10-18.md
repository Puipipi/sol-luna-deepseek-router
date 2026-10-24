# 0.10.5 bounded retry 候选（2026-10-18）

此文档记录源码候选与其构建证据；安装与激活回执见 [0.10.5 更新记录](native-plugin-update-0.10.5-2026-10-18.md)。插件 manifest 版本为 `0.10.5`；portable marketplace 只定位本地仓库源，没有独立版本字段，沿用现有格式。

该候选仅让专用 `native_deepseek` role 设置 `unbounded_connection_retries = false`。Rust role allowlist 现在接受该 feature 的禁用项，并保留 `!enabled` 限制，不能由 role 启用此 feature。Sol/root 的 feature 默认值及其他角色配置保持不变。历史 `0.10.4` 安装/验收证据不因候选号变更而重述或升级。

GitHub Actions run `39113348109` 的新 Rust role regression 已观察到预期 RED：前序 Core DeepSeek tests 和该测试的编译均成功；targeted step 确认 `running 1 test`，`apply_role_can_disable_unbounded_connection_retries_without_changing_parent` 因 `parent_enabled=true, role_enabled=false` 时仍得到 `true` 而失败（0 passed、1 failed、2659 filtered out）。RED patch 的 SHA 为 `7689ca21cf42c9b9e29a7956b515f58651bae5a9f8a4e38c30790982b78a6925`。增加 disable-only role allowlist 的完整候选 patch SHA 为 `7a5c127a24c2c2b80d3933ad9590c4766fb7a1a99b4a917bc607eedde1f734d8`。Windows GREEN run `39115060111` 的精确目标测试实际执行 1 项并通过，release CLI 构建成功；工件 provenance 对应上游源提交 `4ebc485ca321243727539187169425fcf972f2c4` 与该 patch。构建、下载和安装/激活状态的脱敏证据见更新记录。此后该主机已完整退出并重启 Codex，实际观察到新 CLI 运行；部分桌面、故障恢复与多聊天证据见[后续验收记录](native-desktop-acceptance-0.10.5-2026-10-18.md)。该主机的全目标矩阵仍未全部通过，其他主机也未据此验收。
