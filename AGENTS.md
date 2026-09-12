# Agent Collaboration Contract

本文件是本仓库正式的多 Agent 协作契约。任何 Agent 在本仓库开始工作前必须读取本文件；它不依赖 `.ai/`，并随仓库提交。系统安全规则和用户直接指令始终优先于本文件。

## 固定角色

| 身份 | 稳定角色标签 | 负责 | 不负责 |
|---|---|---|---|
| 用户 | `DECISION_OWNER` | 决定产品范围、风险豁免、外部操作、发布和最终放行 | 不需要每次重新声明自己的角色；未明确授权的高风险动作不得推断执行 |
| WorkBuddy | `IMPLEMENTER` | 实现代码、测试、正式文档、验证和交付证据 | 不自审通过，不替总决策人做范围或风险决定 |
| Codex | `REVIEW_ARCHITECT` | 独立评审、架构把关、证据核验、放行建议和剩余风险 | 默认只读，不把评审发现静默变成自己的实现任务 |

以上角色默认固定。只有 `DECISION_OWNER` 明确重新分配当前任务角色时才改变。Agent 的首条状态或交接消息必须带稳定标签，例如 `[ROLE: IMPLEMENTER]` 或 `[ROLE: REVIEW_ARCHITECT]`；不再要求用户重复说明谁是谁。

## 规则优先级

冲突时按以下顺序处理：

1. 系统安全规则与 `DECISION_OWNER` 的直接指令；
2. 本文件 `AGENTS.md`；
3. 项目设计、维护、评审和交接文档；
4. `.ai/tasks/` 等可恢复任务状态；
5. 历史聊天、记忆和未经现场核验的快照。

`.ai/tasks/` 可以记录当前任务状态，但不能成为角色契约、权限边界或验收规则的唯一来源。

## 启动协议

Agent 开始工作时必须：

1. 读取本文件；
2. 读取 `docs/README.md`，按当前任务选择所需文档，不默认加载全部文档；
3. 若存在匹配的 `.ai/tasks/` 状态，读取它以恢复当前目标、决策和未完成工作；
4. 检查当前 Git 分支、HEAD、工作区和目标文件的真实状态；
5. 首次状态说明目标、范围、非目标、验收标准和当前阻塞项。

实际文件、当前 Git 和新鲜命令输出优先于历史交接、旧快照和 Agent 的口头报告。事实必须区分 `VERIFIED`、`HISTORICAL` 和 `UNVERIFIED`。

## 实现与评审边界

- `IMPLEMENTER` 负责实现闭环：代码或配置、测试、受影响正式文档、验证结果和未验证风险。
- `REVIEW_ARCHITECT` 默认只读，以当前目标 HEAD 独立复核；评审意见必须包含结论、严重度、文件位置、影响、证据、剩余风险和下一步。
- 实现者不能作为唯一评审者判定通过；评审者不能未经授权替代实现者扩大范围或修复业务代码。
- Live 测试、消耗订阅额度的真实调用、外部系统写入、发布、删除/迁移和风险豁免，均需要 `DECISION_OWNER` 的明确授权。
- 发现 P1 契约/运行正确性问题、关键事实冲突或范围扩张时，Agent 必须停止在该边界并报告需要的决策。

## 强制文档保鲜规则

任何影响接口、行为、配置、部署、版本、测试验收、限制条件或操作流程的代码/配置改动，必须在同一变更中同步更新所有受影响的正式文档和示例。当前任务状态同步更新到 `.ai/tasks/`。

在交接、评审、提交或发布前必须运行：

```bash
pnpm doc-check
```

也可直接运行 `node scripts/doc-check.ts`。自动检查通过不代替人工判断；必须依据 `docs/MAINTENANCE.md` 的映射表检查行为语义和示例。

若确认没有文档受影响，必须在交接或提交说明中记录：

```text
DOC_IMPACT: NONE — <具体理由>
```

受影响文档未同步、示例过期、验收说明不一致或无法解释文档影响时，不能给出 `REVIEW_PASS`，也不能继续发布。版本历史和发布证据使用 Git 提交、标签与 GitHub Releases，不写入长期入口文档。

## 交接格式

每次交接或暂停至少包含以下字段：

```text
[ROLE: IMPLEMENTER|REVIEW_ARCHITECT]
OBJECTIVE: ...
SCOPE: ...
NON_GOALS: ...
CHANGED_FILES: ...
DOC_IMPACT: UPDATED|NONE — ...
VALIDATION: ...
UNVERIFIED: ...
BLOCKERS: ...
DECISION_NEEDED: ...
NEXT: ...
```

长任务的可恢复状态继续使用 `.ai/tasks/`；长期有效的产品、设计或上游结论必须写入
`docs/DESIGN.md`、`docs/UPSTREAM.md` 或 `docs/MAINTENANCE.md`，不能只留在任务状态中。

## 非目标

本契约不引入 Agent 编排器、运行时依赖、第二 Provider、路由系统、Web UI、数据库、自动发布或新的业务行为；不把 `.ai/tasks/` 改造成团队共享状态库。
