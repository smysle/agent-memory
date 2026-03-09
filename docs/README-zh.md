# AgentMemory 中文说明

AgentMemory 的主 README 已统一为英文：

- [README.md](../README.md)

v4 的一句话定位：

> 面向 AI agent 的 memory layer，支持 CLI / MCP / HTTP，强调写入质量、
> 检索质量，以及生命周期管理（decay / govern / reindex / feedback）。

如果你是从 v3 或 OpenClaw 场景过来的，建议先看：

- [v3 → v4 migration guide](migration-v3-v4.md)
- [Generic runtime integration](integrations/generic.md)
- [OpenClaw integration](integrations/openclaw.md)
- [Architecture overview](architecture.md)

说明：

- v4 不再默认假设你使用 OpenClaw
- `memory/*.md + MEMORY.md` 现在是 **optional workflow**，不是产品定义
- OpenClaw 仍然支持，但被下沉为一个实践良好的宿主示例
