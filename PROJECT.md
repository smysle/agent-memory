# 📋 PROJECT.md — AgentMemory v2 项目管理总纲

## 项目概述

| 项目 | AgentMemory v2 |
|------|----------------|
| 仓库 | https://github.com/smysle/agent-memory |
| 目标 | 基于睡眠周期的 AI Agent 记忆系统，融合五家方案精华 |
| 负责人 | 诺亚（开发）+ 小心（产品/决策） |
| 启动日期 | 待定 |
| 预计工期 | 5-7 天 |
| 技术栈 | TypeScript + Node.js ≥18 + SQLite (better-sqlite3) + MCP SDK |

## 文档索引

| 文档 | 说明 |
|------|------|
| [PLANNING.md](PLANNING.md) | 技术规划（架构、数据模型、特性来源对照） |
| [ROADMAP.md](ROADMAP.md) | 详细路线图（阶段、任务、里程碑、排期） |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 验收标准（功能测试、性能指标、质量门禁） |
| [COMPLETION.md](COMPLETION.md) | 收尾清单（发布、文档、迁移、公告） |

## 核心原则

1. **简单优于复杂** — 3 个生产依赖，不多加
2. **实战验证优于理论设计** — v1 踩过的坑就是 v2 的护栏
3. **先跑通再优化** — 每个 Phase 结束都要能用
4. **测试覆盖 ≥80%** — 记忆系统不容有错

## 参考项目

| 项目 | 吸收的精华 |
|------|-----------|
| nocturne_memory | URI路径、Content-Path分离、boot加载、快照 |
| Memory Palace | Write Guard、意图搜索、vitality衰减、治理循环 |
| PowerMem | 艾宾浩斯曲线、知识图谱、冲突合并、多Agent |
| AgentMemory v1 | 睡眠周期、去重、四准则、情感优先、P0-P3分级 |
