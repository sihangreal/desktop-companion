# SPEC-003 任务清单

> 约定：每个任务完成即勾选；每个阶段结束跑一次真实对话验证，再提交。
> 关联编号指向 `spec.md` 的需求条目。

---

## S1 · 会话记录（`electron/session.js`）

- [x] T-101 建立 `data/sessions/` 目录，缺失时自动创建（FR-301、NFR-307）
- [x] T-102 实现 `append(record)`：序列化 → 追加 → 失败仅记日志（FR-308、NFR-302）
- [x] T-103 实现 `open(date)`：读取当天 JSONL，逐行容错（FR-303、§7 坏行）
- [x] T-104 实现 `recent(n)`：返回最近 n 轮原始消息（FR-313）
- [x] T-105 `turnId` 生成 `t_YYYYMMDD_NNNN`，当日自增（FR-309）
- [x] T-106 实现 `cleanup(7)`：删除 7 天前的 `.jsonl` 与 `.meta.json`（FR-310）
- [x] T-107 启动时调用 `cleanup`，并在日志记录删除数量（FR-310）
- [x] T-108 实现 `clearAll()`：清空 sessions 内容（FR-312）
- [x] T-109 主流程接入：ASR 后写 user 行、整轮结束写 assistant 行（FR-306、FR-307）

**DoD**：聊 3 轮 → 重启 → `logs` 显示加载 3 轮；`sessions/当天.jsonl` 有 6 行合法 JSON。

---

## S2 · 人设可编辑（`electron/persona.js` + 界面）

- [x] T-201 定义 `persona.json` 结构与默认值（§3.5）
- [x] T-202 `get()`：缺字段补默认、文件损坏整体回退（NFR-307）
- [x] T-203 `set(patch)`：校验 name 非空（≤20 字）、identity ≤800 字（FR-333）
- [x] T-204 `set` 使用原子写（tmp + rename）（§3.3）
- [x] T-205 `reset()` 恢复默认人设（FR-332）
- [x] T-206 IPC：`persona:get` / `persona:set` / `persona:reset`（§6）
- [x] T-207 设置面板加人设编辑区（名称输入 + 身份多行 + 约束多行 + 保存/恢复默认）
- [x] T-208 保存后提示"下一轮生效"，并立即刷新界面显示（FR-331）

**DoD**：把身份改成"说话很冷淡"→ 保存 → 下一轮语气明显变化；重启后仍是新值。

> ⚠ 实测补充（2026-11-23）：**空历史时 100% 生效**（测试人设「只回收到」→ 回复正好"收到"）；
> **有历史时不生效**——模型会模仿历史里的旧回复，在 system 里追加「忽略旧语气」也压不过。
> 需要决策：换人设时是否清空上下文（见 S2 汇报的 A/B/C 三案）。

---

## S3 · Prompt 组装（`electron/prompt.js`）

- [x] T-301 实现四段拼装：身份 / 记忆 / 摘要 / 约束，空段跳过（FR-324、FR-325）
- [x] T-302 实现 `est(text)` 粗算 token（中文按 1 字 = 1 token）
- [x] T-303 实现裁剪：摘要 >60→40→20 字，facts >5 按置信度删，identity 截 300 字（FR-328）
- [x] T-304 实现历史裁剪：超 1200 token 删最老两条（FR-328）
- [x] T-305 返回 `{ system, messages, budget }`（§6）
- [x] T-306 引擎改造：`runTurn({ system, messages })`，删除内部 persona/history 参数（D-308）
- [x] T-307 日志输出 system 前 200 字（脱敏）（FR-329）
- [x] T-308 单元测试：超长摘要、facts=20、history=30 条 → 断言预算不超（§6）

**DoD**：`logs` 能看到四段 system；单测全绿；对话正常。

---

## S4 · 摘要与长期记忆（`memory.js` + `memory-job.js`）

- [x] T-401 `memory.facts()` / `merge()`：白名单 key、去重、置信度门槛 0.6（FR-320、FR-323）
- [x] T-402 上限 20 条，超出按 confidence 升序淘汰（§3.4）
- [x] T-403 `memory.clear()`（FR-312）
- [x] T-404 窗口溢出检测：>12 轮时收集被挤出的轮次（FR-314）
- [x] T-405 `memory-job`：一次调用同时产出 summary 与 facts，严格 JSON 解析（§3.2）
- [x] T-406 无溢出时 summary 为 null，只更新 facts（§3.2）
- [x] T-407 续写 `meta.json` 的 summary 与 summarizedThrough（FR-317）
- [x] T-408 超时 10s 放弃、失败保留旧值（FR-316、§7）
- [x] T-409 跨天：读取前一天 meta.summary 作为昨日摘要（FR-318、D-301）
- [x] T-410 异步执行，不 await，不阻塞 `done`（FR-316、NFR-305）
- [x] T-411 单元测试：合并冲突、超限淘汰、非法 JSON（§6）

**DoD**：聊 20 轮 → 问第 1 轮内容 → 她能答上（摘要形式）；说"我叫阿哲"→ 10 轮后仍记得。

---

## S5 · 导出与隐私开关

- [ ] T-501 `exportToday()`：按 §3.6 生成 Markdown（FR-335）
- [ ] T-502 导出前创建 `data/exports/`，返回绝对路径
- [ ] T-503 设置面板加"导出今天"按钮，完成后显示路径
- [ ] T-504 `config.recordPaused` 默认 false，加入 store 默认值（FR-336）
- [ ] T-505 暂停时跳过 append 与 memory-job，仍正常对话（FR-336）
- [ ] T-506 面板加"暂停记录"开关，状态持久化
- [ ] T-507 面板加"清空全部记录"按钮（二次确认）（FR-312）
- [ ] T-508 `session:stats` 显示当天轮次数与最近 5 条摘要（FR-334）

**DoD**：导出的 md 能被 VS Code 正常预览；暂停后 `sessions/` 不再增长。

---

## S6 · 验证与回归

- [ ] T-601 AC-301 重启恢复
- [ ] T-602 AC-302 超窗摘要
- [ ] T-603 AC-303 7 天清理（伪造 8 天前文件）
- [ ] T-604 AC-304 长期记忆称呼
- [ ] T-605 AC-305 人设生效
- [ ] T-606 AC-306 首声无显著退化（对比 ≤100ms）
- [ ] T-607 AC-307 坏行容错
- [ ] T-608 AC-308 导出内容一致
- [ ] T-609 回归：装扮/收藏/播放方式/全屏/双视频未受影响
- [ ] T-610 更新 `docs/engine-v2-diagrams.md`（加会话层）

**DoD**：AC-301～308 全过，回归项无变化，文档同步。

---

## 未纳入本清单

| 项 | 原因 |
|---|---|
| PLAN-002-A 音质修复（切句、视频同步） | 独立方案，等 SPEC-003 落地后再做 |
| 事实提取用便宜模型 | 需要第二个供应商，暂不引入 |
| 会话界面（浏览历史） | 本期只做导出与统计 |
