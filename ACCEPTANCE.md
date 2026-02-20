# ✅ ACCEPTANCE.md — 验收标准

## 功能验收矩阵

### 核心功能（必须通过）

| # | 功能 | 测试方法 | 通过标准 |
|---|------|---------|---------|
| A1 | remember 写入 | 单元测试 | 写入成功，返回 memory ID |
| A2 | remember 去重 | 单元测试 | 相同 hash 不创建新记录 |
| A3 | remember 冲突合并 | 单元测试 | BM25 >0.85 时触发更新而非新建 |
| A4 | recall BM25 搜索 | 单元测试 | 相关记忆排在前 3 |
| A5 | recall_path URI | 单元测试 | 精确返回匹配 URI 的记忆 |
| A6 | recall Priority 加权 | 单元测试 | P0 记忆在同等相关度下排更前 |
| A7 | forget 软删除 | 单元测试 | vitality 降至 0，不物理删除 |
| A8 | link 关联 | 单元测试 | 两条记忆建立关系 |
| A9 | link 多跳遍历 | 单元测试 | A→B→C 可从 A 找到 C |
| A10 | snapshot 自动快照 | 单元测试 | update 前自动保存旧内容 |
| A11 | snapshot 回滚 | 单元测试 | 回滚后内容恢复 |
| A12 | boot 加载 | 单元测试 | 返回所有 P0 + system://boot 记忆 |
| A13 | reflect sync | 集成测试 | 输入对话 → 提取新记忆 → 去重写入 |
| A14 | reflect tidy | 集成测试 | 压缩旧记忆 + 四准则蒸馏 |
| A15 | decay 艾宾浩斯 | 单元测试 | P3 记忆 14 天后 vitality ≈ 0.37 |
| A16 | decay 续期 | 单元测试 | recall 后 stability 增长 |
| A17 | govern 孤儿清理 | 单元测试 | 无 path 的记忆被标记 |
| A18 | govern 低活力归档 | 单元测试 | vitality < 0.05 的 P3 被归档 |
| A19 | agent_id 隔离 | 单元测试 | Agent A 看不到 Agent B 的记忆 |
| A20 | Write Guard 四准则 | 单元测试 | 不满足准则的 P0/P1 写入被拒绝 |

### MCP 接口（必须通过）

| # | 工具 | 测试方法 | 通过标准 |
|---|------|---------|---------|
| B1 | MCP remember | 端到端 | stdio 调用成功写入 |
| B2 | MCP recall | 端到端 | 返回搜索结果 |
| B3 | MCP recall_path | 端到端 | URI 精确查找 |
| B4 | MCP boot | 端到端 | 返回身份记忆 |
| B5 | MCP forget | 端到端 | 降低活力值 |
| B6 | MCP link | 端到端 | 建立关联 |
| B7 | MCP snapshot | 端到端 | 返回快照列表 |
| B8 | MCP reflect | 端到端 | 触发睡眠周期 |
| B9 | MCP status | 端到端 | 返回统计信息 |

### CLI（必须通过）

| # | 命令 | 通过标准 |
|---|------|---------|
| C1 | `agent-memory init` | 创建 SQLite 数据库 + 表结构 |
| C2 | `agent-memory remember "内容" --uri core://test` | 写入成功 |
| C3 | `agent-memory recall "关键词"` | 返回匹配结果 |
| C4 | `agent-memory status` | 显示各层数量、总大小、健康度 |
| C5 | `agent-memory boot` | 显示核心身份记忆 |
| C6 | `agent-memory migrate ./memory/` | 导入 Markdown 文件 |

### 迁移（必须通过）

| # | 场景 | 通过标准 |
|---|------|---------|
| D1 | 迁移 MEMORY.md | 按 ## 分段导入，自动分配 URI 和 Priority |
| D2 | 迁移 memory/*.md 日记 | 按日期导入为 P3 事件 |
| D3 | 迁移 memory/weekly/*.md | 导入为 P2 知识 |
| D4 | 迁移前自动备份 | 原文件不被修改 |
| D5 | dry-run 模式 | 预览导入结果但不写入 |

## 性能指标

| 指标 | 目标 | 测量方法 |
|------|------|---------|
| remember 写入延迟 | < 10ms | vitest benchmark |
| recall BM25 搜索延迟 | < 50ms（1000条记忆） | vitest benchmark |
| recall 搜索延迟 | < 200ms（10000条记忆） | vitest benchmark |
| boot 加载延迟 | < 20ms | vitest benchmark |
| decay 批量更新 | < 100ms（1000条） | vitest benchmark |
| 数据库文件大小 | < 10MB（1000条记忆） | 实测 |
| 内存占用 | < 50MB（MCP Server 运行时） | 实测 |

## 质量门禁

| 指标 | 要求 |
|------|------|
| 测试覆盖率 | ≥ 80% |
| TypeScript 严格模式 | strict: true |
| 零 lint 警告 | eslint 通过 |
| 构建成功 | tsup build 零错误 |
| npm 包可安装 | `npm install` 后 CLI 可用 |
| 无安全漏洞 | `npm audit` 无 high/critical |

## 兼容性测试

| 环境 | 要求 |
|------|------|
| Node.js 18 | ✅ 通过 |
| Node.js 20 | ✅ 通过 |
| Node.js 22 | ✅ 通过 |
| Linux x64 | ✅ 通过 |
| macOS arm64 | ✅ 通过（better-sqlite3 预编译） |
| Windows x64 | ✅ 通过（better-sqlite3 预编译） |
