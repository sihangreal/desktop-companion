# SPEC-003 · 会话记录、记忆与 Prompt 架构

| 项 | 内容 |
|---|---|
| 文档 ID | SPEC-003 |
| 版本 | v1.0（待审核） |
| 状态 | **Draft — 未实施** |
| 日期 | 2026-11-23 |
| 上游 | SPEC-002（对话引擎 v2）、PLAN-002-B |
| 下游 | `plan.md`、`tasks.md`（审核通过后编写） |
| 范围 | 会话记录、上下文与记忆、Prompt 分层、人设可编辑 |

---

## 1. 背景

引擎 v2 已跑通（DeepSeek LLM + MiMo 流式 TTS），但上下文能力只有一条内存数组：

| 现状 | 代码位置 |
|---|---|
| 最多 12 轮，超出从头部丢弃 | `main.js:662` `MAX_HISTORY_TURNS = 12` |
| 只在内存，重启即丢 | 无任何落盘 |
| 人设为硬编码常量 | `main.js:664` `PERSONA` |
| Prompt 无分层，无法单独调整 | `engine.js:157` 直接拼 `[...history, user]` |

结果：她会"忘事"，用户无法查看聊过什么，也无法改她的性格。

---

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 |
|---|---|
| G-1 | 每轮对话**落盘可查**，重启后当天上下文仍在 |
| G-2 | 超出窗口的历史**不丢失**，压缩为摘要进入 system prompt |
| G-3 | 具备**跨天长期记忆**（称呼、偏好、雷区） |
| G-4 | Prompt 拆分为四段，可分别开关与调参 |
| G-5 | **人设可由用户编辑**，保存后下一轮生效 |
| G-6 | 记录自动清理，默认保留 **7 天** |

### 2.2 非目标

| ID | 非目标 | 原因 |
|---|---|---|
| NG-1 | 多会话/多角色管理 | 单角色结构不变 |
| NG-2 | 云端同步 | 本地优先，隐私 |
| NG-3 | 向量检索 / RAG 记忆 | 规模不需要，先做规则+摘要 |
| NG-4 | 语音记录存档 | 只存文本，省空间与隐私 |
| NG-5 | 修改引擎的音频链路 | 属 PLAN-002-A 范围 |

---

## 3. 术语与数据模型

### 3.1 目录结构

```
data/
├─ sessions/
│   ├─ 2026-11-23.jsonl        # 逐轮记录（追加写）
│   └─ 2026-11-23.meta.json    # 当日摘要与游标
├─ memory.json                 # 跨天长期事实
├─ persona.json                # 用户可编辑人设
└─ logs/main.log
```

### 3.2 轮次记录（JSONL 每行一条）

```jsonc
{
  "turnId": "t_20261123_0007",
  "ts": "2026-11-23T22:10:04+08:00",
  "role": "assistant",          // user | assistant
  "text": "那早点休息，别熬太晚。",
  "emotion": "worried",          // 仅 assistant
  "firstTokenMs": 412,           // 仅 assistant
  "firstAudioMs": 1080,
  "audioMs": 2400,
  "provider": { "llm": "deepseek-chat", "tts": "mimo-v2.5-tts" }
}
```

**约束**：一行必须是完整 JSON；写盘前先序列化，失败则不写（不写半行）。

### 3.3 当日元数据

```jsonc
{
  "date": "2026-11-23",
  "summary": "聊到工作压力和睡眠，她答应早点睡。",
  "summarizedThrough": "t_20261123_0004",  // 已并入摘要的最后一条 turnId
  "updatedAt": "2026-11-23T22:30:00+08:00"
}
```

### 3.4 长期事实

```jsonc
{
  "facts": [
    { "key": "user.name", "value": "阿哲", "confidence": 0.9,
      "sourceTurnId": "t_20261120_0003", "updatedAt": "2026-11-20T20:11:00+08:00" },
    { "key": "user.dislike", "value": "被叫宝贝", "confidence": 0.8,
      "sourceTurnId": "t_20261121_0009", "updatedAt": "2026-11-21T21:02:00+08:00" }
  ]
}
```

- 最多 **20 条**；超出按 `confidence` 升序淘汰
- 同 `key` 新值覆盖旧值，`confidence` 取新值
- 用户可一键清空

### 3.5 人设

```jsonc
{
  "name": "小夜",
  "identity": "住在用户桌面上的陪伴角色，中文女性……",   // 用户可编辑
  "constraints": "只输出口语；首句≤12字；总长≤45字；第一行 [emotion:xxx]。",
  "updatedAt": "2026-11-23T22:00:00+08:00"
}
```

缺字段时用内置默认值补齐；文件损坏则整体回退默认并记录日志。

---

## 4. 功能需求

### 4.1 会话边界（按天）

| ID | 需求 |
|---|---|
| FR-301 | 每轮开始时按**本地日期**确定会话文件 `sessions/YYYY-MM-DD.jsonl` |
| FR-302 | 跨零点后自动写入新日期文件，不修改旧文件 |
| FR-303 | 启动时加载**当天**文件末尾最多 12 轮进短期窗口 |
| FR-304 | 当天无文件时不报错，窗口为空 |
| FR-305 | 系统时钟回跳（日期变小）时，仍以当前本地日期为准，不覆盖旧文件 |

### 4.2 记录写入

| ID | 需求 |
|---|---|
| FR-306 | user 文本在 ASR 完成后立即写一行；assistant 在整轮结束后写一行 |
| FR-307 | assistant 行必须包含 emotion 与三项耗时 |
| FR-308 | 写入采用追加模式，失败时记录日志并继续对话（不阻塞） |
| FR-309 | `turnId` 格式 `t_YYYYMMDD_NNNN`，当日自增 |

### 4.3 留存与清理

| ID | 需求 |
|---|---|
| FR-310 | 启动时删除**早于 7 天**的 `sessions/*.jsonl` 与 `*.meta.json` |
| FR-311 | `memory.json` 与 `persona.json` **不参与**自动清理 |
| FR-312 | 提供"清空全部记录"入口，删除 sessions 目录内容并清空 memory |

### 4.4 短期窗口与摘要

| ID | 需求 |
|---|---|
| FR-313 | 短期窗口保留最近 **12 轮**（24 条）原文，超出部分进入摘要 |
| FR-314 | 触发条件：窗口溢出时，取最老 **4 轮**并入摘要 |
| FR-315 | 摘要由 LLM 生成，提示词要求"第三人称、≤120 字、只保留事实与情绪走向" |
| FR-316 | 摘要调用**异步**执行，不阻塞当前轮；失败则保留原摘要并下轮重试 |
| FR-317 | 摘要写入 `meta.json` 的 `summary`，并推进 `summarizedThrough` |
| FR-318 | 跨天时，前一天 `meta.json` 的 `summary` 作为「昨日摘要」带入 system（可开关，默认开） |

### 4.5 长期事实提取

| ID | 需求 |
|---|---|
| FR-319 | 每轮结束后异步调用一次 LLM，输入最近 2 轮，输出 JSON 事实数组 |
| FR-320 | 只接受白名单 key：`user.name`、`user.dislike`、`user.like`、`user.job`、`user.schedule`、`user.event` |
| FR-321 | 提取结果按 key 合并进 `memory.json`，写入前做原子替换（临时文件 + rename） |
| FR-322 | 提取失败或返回非法 JSON 时忽略，不影响对话 |
| FR-323 | 同一 key 的更新需 `confidence ≥ 0.6` 才覆盖 |

### 4.6 Prompt 组装

| ID | 需求 |
|---|---|
| FR-324 | system prompt 由四段按序拼接：身份、记忆、摘要、约束 |
| FR-325 | 任一段为空时跳过，不留空行 |
| FR-326 | messages = 最近 12 轮原文 + 本轮 user |
| FR-327 | 总预算：system ≤600 token、历史 ≤1200 token、输出 ≤220 token |
| FR-328 | 超预算时按顺序裁剪：先缩减摘要 → 再删最老轮次 → 最后截断 facts 到 5 条 |
| FR-329 | 拼装结果在日志中输出前 200 字（脱敏后）便于排查 |

### 4.7 人设可编辑

| ID | 需求 |
|---|---|
| FR-330 | 设置面板提供人设编辑（名称、身份描述、约束），保存写入 `persona.json` |
| FR-331 | 保存后**下一轮**生效，不要求重启 |
| FR-332 | 提供"恢复默认人设"按钮 |
| FR-333 | 名称为空时回退默认"小夜"；身份描述超过 800 字时拒绝保存并提示 |

### 4.8 查看与导出

| ID | 需求 |
|---|---|
| FR-334 | 设置面板显示当天轮次数与最近 5 条摘要（只读） |
| FR-335 | 提供"导出当天记录"为 `data/exports/YYYY-MM-DD.txt`（纯文本，一行一轮） |

---

## 5. 非功能需求

| ID | 需求 | 指标 |
|---|---|---|
| NFR-301 | 写盘不阻塞对话 | 单次追加 ≤5ms |
| NFR-302 | 崩溃安全 | 只追加完整行，最多丢失当前未完成轮 |
| NFR-303 | 启动加载 | 当天文件 ≤2000 行时，加载 ≤100ms |
| NFR-304 | 磁盘占用 | 每天 ≤200KB；7 天 ≤1.5MB |
| NFR-305 | 摘要/事实调用成本 | 每轮 ≤1 次额外 LLM 调用，且不阻塞主链路 |
| NFR-306 | 隐私 | 记录仅存本地；`data/` 已在 `.gitignore` 中 |
| NFR-307 | 兼容 | 缺少任一文件时按默认值运行，不崩溃 |

---

## 6. 接口

```js
// electron/session.js
session.open(date)                 // 返回 { turns, meta }
session.append(record)             // 追加一行，返回 boolean
session.recent(n)                  // 最近 n 轮原文
session.meta()                     // { summary, summarizedThrough }
session.setMeta(patch)
session.cleanup(days = 7)
session.clearAll()
session.exportToday()

// electron/memory.js
memory.facts()                     // Fact[]
memory.merge(facts)                // 合并、去重、限 20 条
memory.clear()

// electron/persona.js
persona.get()                      // Persona
persona.set(patch)                 // 校验后落盘
persona.reset()

// electron/prompt.js
prompt.build({ persona, facts, summary, yesterdaySummary, recent, userText })
// → { system, messages, budget: { systemTokens, historyTokens } }
```

引擎接口变化：`runTurn({ prompt: { system, messages }, ... })`，不再接收 `persona/history`。

### IPC 新增

| 通道 | 说明 |
|---|---|
| `persona:get` / `persona:set` / `persona:reset` | 人设读写 |
| `memory:get` / `memory:clear` | 事实查看与清空 |
| `session:stats` | 当天轮次数、摘要 |
| `session:export` | 导出当天记录 |
| `session:clearAll` | 清空全部记录 |

---

## 7. 边界与异常

| 场景 | 处理 |
|---|---|
| 记录文件被外部删除 | 下次写入时自动重建目录与文件 |
| 某行 JSON 损坏 | 跳过该行，继续解析其余行，日志记一条 |
| 摘要调用超时（>10s） | 放弃本次，保留旧摘要，下轮重试 |
| facts 提取返回非 JSON | 忽略，不写盘 |
| 同 key 事实冲突 | 取 `confidence` 高者；相同则取更新者 |
| 用户在跨零点前说话、回复跨过零点 | 以**轮次开始时间**归属日期 |
| 磁盘写满 | 记录日志并静默降级为纯内存模式 |
| 人设被清空 | 回退默认人设，不阻塞 |

---

## 8. 验收标准

| ID | 标准 | 方法 |
|---|---|---|
| AC-301 | 重启后当天最近 12 轮仍在上下文 | 聊 5 轮，重启，问"刚才聊了啥" |
| AC-302 | 超过 12 轮后，第 1 轮内容仍在 system（摘要形式） | 聊 20 轮，检查日志中的 system 含早期信息 |
| AC-303 | `sessions/` 下只保留 7 天文件 | 伪造 8 天前文件，启动后应被删除 |
| AC-304 | 说"我叫阿哲"后 10 轮，她仍能正确称呼 | 实测 |
| AC-305 | 改人设后下一轮生效 | 改成"说话很冷淡"，下一轮语气变化 |
| AC-306 | 摘要/事实调用不拖慢首声 | 对比开启前后 `首声` 指标，差值 ≤100ms |
| AC-307 | 损坏 JSONL 不影响启动 | 手工插入坏行，重启应正常 |
| AC-308 | 导出文件内容与界面一致 | 人工比对 |

---

## 9. 决策记录

| ID | 决策 | 理由 |
|---|---|---|
| D-301 | 会话按**本地自然日**切分 | 用户选择；也便于"昨天聊了什么"这类自然提问 |
| D-302 | 记录保留 **7 天** | 用户选择；7 天约 1.5MB |
| D-303 | 摘要与事实提取**同时实现** | 用户选择；两者共用一次 LLM 调用可省成本 |
| D-304 | 人设**可编辑**，存 `persona.json` | 用户选择 |
| D-305 | 用 JSONL 而非 SQLite | 追加安全、可读、无依赖、崩溃友好 |
| D-306 | 摘要用同一 LLM，不用小模型 | 标注需求，暂不引入第二个供应商 |
| D-307 | facts 上限 20 条 | 控制 system 膨胀 |
| D-308 | 引擎只接收 `{system, messages}` | 存储与拼装解耦，便于测试 |

---

## 10. 开放问题（需你确认）

| ID | 问题 | 建议默认 |
|---|---|---|
| Q-301 | 跨天时是否带入「昨日摘要」？ | 带入（FR-318 默认开） |
| Q-302 | 事实提取每轮都跑，还是每 3 轮跑一次？ | 每轮（成本低，记忆更及时） |
| Q-303 | 摘要触发阈值 12 轮 / 每次并 4 轮，是否合适？ | 合适，可调 |
| Q-304 | 是否需要"暂停记录"开关（隐私场景）？ | 需要，放设置面板 |
| Q-305 | 导出格式用 txt 还是 md？ | txt（一行一轮，便于 grep） |
