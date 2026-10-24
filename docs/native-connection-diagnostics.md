# 本地连接事件快照

`scripts/native-connection-diagnostics.mjs` 提供显式只读采集函数和 `--collect --json` CLI。没有常驻 watcher，也没有挂接空闲会话的钩子；只有明确启用后才会执行。`enabled: false` 在解析路径、建锁目录或打开 SQLite 之前直接返回。

采集器仅以只读方式打开 `CODEX_HOME/logs_2.sqlite`，从 `logs` 表检查最近 72 小时、最多 500 行。首次采集和检测到日志轮转时选最新的有界窗口；之后按 rowid 游标增量读取。它只接受已知 Responses 网络 target（`codex_core::responses_retry`、`codex_core::client`、`codex_api::endpoint::responses_websocket` 及其子 target），工具执行、MCP、shell 等 target 即使文本出现相同错误字串也会排除。列存在时优先使用 `feedback_log_body`，否则使用旧 schema 的 `message`；选定列显式传入分类器。

快照文件按 parent thread ID 的 SHA-256 分开存放，不保存原 ID。相同 parent 的读游标、查询和快照写入由插件 `withFileLock` 串行化；等待锁最多 120ms，锁忙或其他失败返回 `available: false`，不阻塞主任务。跨聊天只共享经过固定分类和字段白名单筛选的连接事件，不包含聊天标题或消息内容。每份快照最多保留 128 个事件，通过插件原子 JSON 写入 helper 保存。数据库缺失、锁定或 schema 不符时不会抛出到调用方。

事件只含 UTC 时间、已知 target、固定错误类别、有限 retry 序号、日志明确记载时的数值 close/status/byte 字段、thread/process 哈希及显式相关性。没有明确 thread ID 时标为 `other_or_unknown`；未登记的子代理也如此。`rootCause` 固定为 `uncertain`。HTTP fallback 只证明日志记录了 fallback 尝试，不能证明其成功；没有终态日志不能推断恢复。

显式 CLI 调用示例（集成方提供专属状态目录；不会启动模型 turn）：

```powershell
$env:CODEX_HOME = '<Codex home>'
$env:CODEX_CONNECTION_DIAGNOSTICS_STATE = '<plugin-owned state directory>'
node scripts/native-connection-diagnostics.mjs --collect --json
```

仅读取当前 parent 的已有快照：

```powershell
$env:CODEX_CONNECTION_DIAGNOSTICS_STATE = '<plugin-owned state directory>'
node scripts/native-connection-diagnostics.mjs --json
```

## 历史事件的证据边界

之前对保留期内 Rust 日志的只读统计为 77 条 WebSocket 错误、112 条 sampling retry、12 条 HTTP fallback、0 条 HTTP 5xx、0 条 compaction retry、3 条 payload-too-large。该统计是当时的临时计数，并未保存在可核验快照中。10 月 23 日约 14:36（北京时间）的五次重试与 fallback 记录，发生在不同于父会话 ID 的日志行；当时事件关联线程在 fallback 后没有观察到终态，但无法据此判断请求是否最终成功。日志库之后轮转，incident 行及其 thread/process ID 已不可恢复。以上属于历史诊断记录，不是当前采集结果，也不能用于归因。
