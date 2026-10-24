# 插件 ZIP 候选包

`scripts/package-plugin.mjs` 从指定 Git 仓库生成真正的 `.zip` 安装包。它只读取 Git HEAD 中已跟踪的白名单文件，要求跟踪文件干净；未跟踪文件不会进入包。插件版本取自 `.codex-plugin/plugin.json`，registry ID 取自 `.agents/plugins/marketplace.json`，并验证 manifest、市场条目与 `.mcp.json` 入口彼此匹配。

包内保留插件清单、市场注册信息、MCP 配置、技能、hook、UI、运行脚本、运行所需文档、许可证及 `native/bootstrap` 中跟踪的源码/二进制。CI 专用锁归一化器、CLI 源码 patcher、测试、evidence、procedures、计划和本机环境文件不会打包。`package-manifest.json` 记录相对路径、字节数和 SHA-256，以及版本、registry ID 和源提交；它不记录本机绝对路径，也不对自身做递归哈希。ZIP 创建后由 Windows .NET 解压流逐项核对实际内容哈希，再以不覆盖方式写入目标。受限目录不跟随 Git symlink；输出目录必须与源树分离。

当前 0.12.3 源中的 `native/bootstrap` 有跟踪的 C 源和 EXE，没有单独的编译来源收据。包清单会记录这两个文件的确切哈希和仓库 commit，但这不证明 EXE 可由该 C 源可复现构建。

0.12.3 仅调整连接诊断的 thread 与响应 target 有界查询，并为旧诊断游标增加一次时间窗口回填。此变更不表示底层 10054 连接错误已修复，也不更改 Native Codex 的 transport 行为。

打包使用本机 Windows PowerShell 和 .NET ZIP 支持，不安装新依赖，也不调用模型。Windows 是该 ZIP helper 的受支持平台；非 Windows 上的分发测试会明确显示 `SKIP`，真实 ZIP 创建和解压哈希验收由 Windows 测试作业负责。只支持 `.zip`，不会覆盖已有输出文件。

```powershell
node scripts/package-plugin.mjs `
  --source 'C:\path\to\clean\plugin-worktree' `
  --out 'C:\path\outside\source\distributions\sol-luna-0.12.3.zip'
```

输出 JSON 提供 ZIP 路径、字节数、SHA-256、包版本、registry ID 和源 commit。完整文件清单及逐项哈希在 ZIP 内的 `package-manifest.json`。

安装包只包含插件和随插件运行的 `native/bootstrap/codex-bootstrap.exe`。匹配的定制 Codex CLI 是独立大型构建产物，不放进插件 ZIP，也不会因此自动安装或启用。插件包的字节哈希只证明该候选 ZIP 的内容，不代表当前桌面已经安装它、CLI 兼容探针已通过或真实模型/工具调用已验收。最终 Task5 helper 合入后，应从最终干净源 commit 重新打包并重新核验；本地样例仅对应其记录的源版本。

## 验证

真实 Git fixture 测试覆盖 ZIP 创建及哈希、Unicode 和空格路径、未跟踪文件排除、关键 bootstrap 文件存在、源 tracked dirty 拒绝、manifest 不支持/关键文件缺失、tracked symlink 与用户传入 source junction 拒绝、外部输出和重复输出不覆盖。fixture 根目录先解析 `os.tmpdir()` 的真实路径，兼容 CI 临时目录本身经过 junction 的情况；生产打包器仍拒绝用户指定的 symlink/junction source/output 路径。测试使用 .NET ZIP API 检查 archive，逐项重新计算解压流内容哈希，并读取压缩包内的 manifest 比对清单；这不是只检查 manifest 是否存在。
