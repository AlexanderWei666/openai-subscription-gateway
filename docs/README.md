# 文档索引

这里按“你现在要做什么”组织文档。无需从头读完全部文件。

| 目标 | 先读 | 何时继续读 |
|---|---|---|
| 安装、登录、接入客户端 | [`README.md`](../README.md) | Windows / WSL 混合使用时读 [`WSL.md`](WSL.md) |
| 理解代码或开始开发 | [`DEVELOPMENT.md`](DEVELOPMENT.md) | 改架构前读 [`DESIGN.md`](DESIGN.md) |
| 修改 Codex 上游适配 | [`UPSTREAM.md`](UPSTREAM.md) | 按 [`MAINTENANCE.md`](MAINTENANCE.md) 完成验证和文档同步 |
| 独立评审一个变更 | [`REVIEWING.md`](REVIEWING.md) | 用 Git、当前任务状态和新鲜命令输出确认现场 |
| Agent 接手任务 | [`AGENTS.md`](../AGENTS.md) | 再按任务类型选择本页对应文档和 `.ai/tasks/` 当前状态 |

## 每份文档只负责什么

- `README.md`：普通用户能否安装、启动和正确理解边界。
- `WSL.md`：Windows / WSL 两种部署位置的网络和凭证操作。
- `DEVELOPMENT.md`：代码地图、阅读顺序和本地开发流程。
- `DESIGN.md`：长期架构约束和已经决定的取舍。
- `UPSTREAM.md`：网关实际依赖的 Codex wire 契约及其验证基线。
- `MAINTENANCE.md`：上游变化或代码变化时如何更新、验证和保持文档一致。
- `REVIEWING.md`：与具体版本无关的独立评审清单和输出格式。
- `AGENTS.md`：角色、权限和交接契约；它不承载产品说明。

## 不放进这些入口文档的内容

下面这些信息变化太快，不应长期写死在入口文档中：

- 当前机器上的服务、网络、凭证或工具状态；
- 某次提交的测试数量、文件行数和临时风险清单；
- 一次发布或评审的结果快照；
- 某个客户端 UI 的短期行为。

当前任务进度放在本地 `.ai/tasks/`；版本历史和发布证据放在 Git 提交、标签与
GitHub Releases。长期有效的设计结论才回写到 `DESIGN.md` 或 `UPSTREAM.md`。
