# OpenClaw 核心补丁记录 (by 小可)

## 📌 概述
本文件记录了 zzjj7000 对 OpenClaw 进行的所有架构级优化补丁。
**核心原则**：保持补丁逻辑与官方 `src/routing` 架构解耦，优先使用 `src/routing/` 目录下的自定义插件。

---

## 🛠️ 活跃补丁列表

### 1. Gemini 缓存命中优化器 (Cache Booster)
- **补丁 ID**: `PATCH_001_CACHE_V2`
- **逻辑路径**: `src/routing/context-optimizer.ts`
- **挂载点**: `src/agents/pi-embedded-runner/run.ts`
- **功能**: 通过扫描文件 `mtimeMs` 重新对 Context 进行“稳定性排序”。确保最稳定的文件（如 README, 旧文档）永远排在 Prompt 前端，最大化 Gemini Context Caching 的命中率。
- **合并提示**: 官方更新 `run.ts` 时，需保留 `ContextOptimizer` 的调用。

### 2. 模型经验桥接器 (Experience Bridge)
- **补丁 ID**: `PATCH_002_EXP_DYNAMIC`
- **逻辑路径**: `src/routing/experience-bridge.ts`
- **挂载点**: `src/routing/resolve-route.ts`
- **状态文件**: `.openclaw/state/routing-experience.json`
- **功能**: 记录每个模型在不同场景（Coding/Creative）下的 Token 转化率和成功率，为未来的动态路由提供实战数据支撑。
- **合并提示**: 官方修改路由引擎时，需确保 `optimization` 字段不被丢弃。

### 3. AI-program 智能熔断器 (Circuit Breaker)
- **补丁 ID**: `PATCH_003_BREAKER`
- **逻辑路径**: `F:\DOCUMENT\PROMGRAM\AI-program/server.py`
- **功能**: 事不过三原则。网络故障或重试超过 3 次自动挂起任务并汇报。

---

## 📅 更新日志
- **2026-02-03**: 完成从旧版 `SmartRouter` 到官方新版 `src/routing` 架构的平移工作。
