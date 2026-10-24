# Native API 子代理真实运行验收

`tests/native-api-role-cli-smoke.mjs` 提供一个显式绑定二进制 SHA-256 的本地端到端验收。测试在临时 `CODEX_HOME` 和 workspace 启动隐藏的 app-server；父模型与 `native_api` 子代理模型都由测试进程中的固定 localhost Responses mock 回答。代理网关只允许访问精确的 loopback 地址、端口和路径，子进程的外网代理指向本地拒绝服务。

## 执行

先运行不启动 Codex 的 mock 协议自检：

```powershell
node tests/native-api-role-cli-smoke.mjs --mock-self-test
node tests/native-api-role-cli-smoke.mjs --failure-self-test
```

真实运行必须由调用者从已通过 CI 验证的独立 CLI artifact 提供绝对路径，以及从该 artifact 的构建 provenance 单独取得的 SHA-256：

```powershell
node tests/native-api-role-cli-smoke.mjs --binary 'C:\path\to\ci-validated\codex.exe' --sha256 '<CI-provenance SHA-256>'
```

脚本在启动服务前核对 hash；不查询、选择或安装当前系统 CLI，也不读取用户 Codex 配置或凭据。它使用合成 API key，所有固定模型响应均来自 loopback。若无法提供可信 CI provenance，不要用二进制自身计算的 hash 代替期望值。

测试只在其临时 `CODEX_HOME/config.toml` 中启用 `[features] multi_agent_v2_dynamic_tools = true`，让固定只读工具可用于回环链路。最终 CI artifact `d0cb`（SHA-256 `7ee484bc13f475848449bc2acbf9ca2f841cb235a24def3714d2ed2e09fc47d0`）已在此 fixture 下通过：父/子请求分别为 4/2，`item/tool/call` 回调、子线程历史与退出状态均通过，外部模型调用为 0。结果记录在 `work/runtime-artifacts-20261024/final-d0cb/native-api-role-smoke-result.json`。

这个临时全局 feature 只证明该二进制在显式启用动态工具时可以完成这条原生 API 子代理链路；它不证明角色文件能单独启用该 feature，也不代表真实 root 配置或生产角色会继承父动态工具。测试没有更改真实 root 配置。

`--failure-self-test` 在 localhost mock/gateway 已启动后注入初始化失败，并验证监听服务与测试自有子进程都已关闭；它不启动 Codex CLI。

## 验收范围

真实运行要求父模型收到任务并以真实 `spawn_agent` 启动 `native_api` 子代理。测试在 `thread/start` 注册固定 schema 的只读 `fixture_echo` 工具；子代理必须从真实模型请求中的 `tools` 看到该工具，并以 `function_call` 请求固定 marker。app-server 再通过真实 `item/tool/call` JSON-RPC 向测试客户端请求执行。客户端只在工具名、marker 和非 root thread 均匹配时返回固定文本；未知 server request 不响应。子代理收到工具结果后完成，父任务等待并完成。

脚本以 `thread/list` 核实子代理角色和 parent thread，以 `thread/read` 核实真实 `dynamicToolCall` 项的参数、成功状态、结果和最终消息。输出不包含提示词、响应正文、会话 ID、URL 或凭据。所有模型响应来自 loopback mock；外网代理在本地拒绝连接，不调用任何外部模型。

这验证 CLI/app-server 的本地原生 API 子代理、动态工具客户端回调和历史记录链，不验证 Codex 桌面 UI、已安装插件或线上模型行为。只读工具不检查 builtin shell 或文件写权限；PowerShell、exec_command、apply_patch 和真实文件变更链均未通过此测试验收。`--mock-self-test` 只验证 mock/gateway 的本地协议，不代表真实 app-server 运行成功。此测试也不验证 WS 重试或 HTTP fallback；WS close/retry 场景需要单独的窄测试。
