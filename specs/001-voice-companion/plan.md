# 桌面语音女伴 · 技术方案（Plan）

| 项 | 内容 |
|---|---|
| 对应规格 | SPEC-001 v1.3 |
| 版本 | v1.0 |
| 日期 | 2026-11-16 |
| 阶段 | P0（MVP）为主，标注 P1 项 |

---

## 1. 方案目标

在 4 个里程碑内交付一个可双击运行、能按住说话、能打断、能换装的 Windows 桌面程序。所有语音能力走 DeepSeek 官方 API，视觉层复用现有 FRAC webm 素材。

**不追求的**：Live2D、精细口型、主动搭话、壁纸形态、跨平台。

---

## 2. 运行架构

### 2.1 进程与线程

```
┌──────────────────────────────────────────────────────────────┐
│ Tauri 主进程（单实例）                                         │
│                                                              │
│  ① Tokio 主运行时（async）                                     │
│      · 会话状态机 / 轮次编排（Turn actor）                      │
│      · HTTP 客户端（LLM 流 / ASR / TTS 流）                     │
│      · SQLite（spawn_blocking 隔离）                           │
│      · 事件总线 → 前端                                          │
│                                                              │
│  ② 采集线程（OS 线程，非 async）                                │
│      WASAPI capture → 环形缓冲 → 16k 重采样 → VAD 帧 → ring   │
│      → 松手后：编码 WAV(内存) → 交给 ① 上传                     │
│                                                              │
│  ③ 播放线程（OS 线程，非 async）                                │
│      24k PCM 环形缓冲 → WASAPI render → 每 20ms 计算 RMS      │
│      → 推给 ① 转成 level 事件                                   │
│                                                              │
│  ④ 全局热键 / 托盘（Tauri 插件）                                │
└──────────────────────────────────────────────────────────────┘
              │ IPC（事件 + 命令）
              ▼
┌──────────────────────────────────────────────────────────────┐
│ WebView2 渲染层（透明置顶窗）                                   │
│   · <video loop muted> 常驻循环（双实例交叉淡入）                │
│   · 状态叠加层（光晕/三点/呼吸）                                │
│   · 字幕气泡 · 衣橱网格 · 设置面板                              │
└──────────────────────────────────────────────────────────────┘
```

**关键决定**：**音频只在 Rust 侧播放，不经 WebView**。原因：
1. 绕开 WebView2 的自动播放策略；
2. 打断时能在 10ms 内清空缓冲，不用等 DOM 事件；
3. 音量包络直接在播放线程算，UI 只收 `level` 数值，省一次 IPC 往返。

### 2.2 为什么采集/播放用独立 OS 线程

WASAPI 回调对时序敏感，放进 tokio 会被调度抖动影响。用 `std::thread` + 无锁环形缓冲（`ringbuf` crate），async 侧只做"取一帧 → 判断"。

---

## 3. 目录结构

```
desktop-companion/
├─ src-tauri/
│  ├─ src/
│  │  ├─ main.rs              # Tauri builder、插件注册
│  │  ├─ app_state.rs         # 全局状态：会话、当前装扮、配置
│  │  ├─ audio/
│  │  │  ├─ capture.rs        # WASAPI 采集 + 16k 重采样
│  │  │  ├─ vad.rs            # Silero VAD（ort）
│  │  │  ├─ wav.rs            # 内存 WAV 编码
│  │  │  └─ playback.rs       # 24k PCM 渲染 + RMS
│  │  ├─ adapters/
│  │  │  ├─ mod.rs            # trait 定义
│  │  │  ├─ asr_deepseek.rs
│  │  │  ├─ llm_deepseek.rs
│  │  │  ├─ tts_deepseek.rs
│  │  │  └─ mock.rs           # 离线自动化测试用
│  │  ├─ turn/
│  │  │  ├─ orchestrator.rs   # 一轮的编排 + 取消
│  │  │  ├─ sentence.rs       # 中文断句 + 首句优先
│  │  │  ├─ persona.rs        # 角色卡 → system prompt
│  │  │  └─ fallback.rs       # 兜底台词
│  │  ├─ store/
│  │  │  ├─ db.rs             # rusqlite + 迁移
│  │  │  └─ models.rs
│  │  ├─ assets/
│  │  │  ├─ scanner.rs        # 扫描 assets/looks/*/look.json
│  │  │  └─ importer.rs       # 从 FRAC 目录批量导入
│  │  ├─ commands.rs          # 前端可调命令
│  │  └─ events.rs            # 事件定义
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ src/                       # 前端（TS + Vite）
│  ├─ main.ts
│  ├─ stage.ts                # 双 video 交叉淡入 + 叠加层
│  ├─ wardrobe.ts             # 衣橱网格/翻页
│  ├─ subtitle.ts
│  ├─ settings.ts
│  └─ styles/
├─ assets/                    # 用户素材（不进安装包）
│  ├─ looks/<lookId>/{look.json, video.webm, cover.jpg}
│  └─ fallback/lines.json
├─ specs/001-voice-companion/{spec.md, plan.md, tasks.md}
└─ docs/{vendor-capabilities.md, known-limits.md}
```

---

## 4. 适配器契约（Rust）

### 4.1 trait 定义

```rust
#[async_trait]
pub trait Asr: Send + Sync {
    /// 整段识别（供应商非流式）。audio 为 16k/mono/16-bit WAV 字节。
    async fn transcribe(&self, wav: Bytes, cancel: CancellationToken)
        -> Result<AsrResult, AdapterError>;
}

pub struct AsrResult { pub text: String, pub duration_ms: u32 }

#[async_trait]
pub trait Llm: Send + Sync {
    /// 返回 token 流；调用方负责按句切分并剥离 emotion 标记。
    fn stream(&self, msgs: Vec<Msg>, cancel: CancellationToken)
        -> BoxStream<'static, Result<String, AdapterError>>;
}

#[async_trait]
pub trait Tts: Send + Sync {
    /// 单句合成，返回 24k/16bit/mono 裸 PCM 的字节流。
    fn synth(&self, text: &str, voice: VoiceId, cancel: CancellationToken)
        -> BoxStream<'static, Result<Bytes, AdapterError>>;
}

pub enum AdapterError {
    Timeout, Unauthorized, QuotaExceeded, ContentRejected,
    BadRequest(String), ServerError(u16), Cancelled, Network(String),
}
```

**错误分类是硬要求**：`ContentRejected` 不重试（FR-036），`Timeout/ServerError` 重试 2 次，`Unauthorized/QuotaExceeded` 终止并提示。

### 4.2 LLM 输出协议

```
[emotion:shy]
那就别硬撑了，靠一会儿？
```

解析规则：
1. 首行正则 `^\[emotion:(neutral|happy|shy|worried|sad|curious|playful)\]$`；
2. 命中则剥离并作为本轮情绪；未命中按 `neutral`，全文当正文；
3. 正文再过一遍"可朗读清洗"：去 `*`、`#`、`[]`、emoji、URL、英文括号注释（FR-029）。

### 4.3 断句与流水线

```
LLM 流出 "……" ──┬─ 遇 ，。？！； 或累积 ≥15 字 → 立即提交 TTS（首句优先）
                └─ 其余累积
TTS(i) 完成 ──► 播放队列（FIFO，可被打断清空）
               └─ 若队列空且下一句已提交 → 预取（FR-038）
```

**首句优先**是延迟关键：`emotion` + 15 字一出现就发起 TTS，不等整段 LLM 结束。

---

## 5. 会话状态机

### 5.1 逻辑状态

```
        ┌──────────────────────────────┐
        │                              │
     ┌──▼───┐  按下热键   ┌─────────┐   │
     │ Idle │───────────►│Listening│   │
     └──▲───┘            └────┬────┘   │
        │  <300ms 误触         │ 松手/VAD 判停
        │                      ▼
        │                 ┌─────────┐
        │                 │Thinking │（ASR → LLM）
        │                 └────┬────┘
        │   失败/兜底           │ 首句就绪
        └──────────────────────┤
                               ▼
                          ┌─────────┐
                          │Speaking │──► 播放结束 → Idle
                          └────┬────┘
                    用户开口 │
                             ▼ Listening（清空播放队列 + cancel token）
```

### 5.2 取消语义

每轮一个 `CancellationToken`，打断时：
1. `playback::flush()` — 清空 PCM 环 → 静音（目标 <30ms，SC-002 要求 300ms）；
2. `cancel.cancel()` — 中止在途 ASR/LLM/TTS HTTP 请求；
3. 丢弃未消费的 TTS 流；
4. 状态置 `Listening`。

**禁止**：只暂停播放不取消请求（会在后台继续烧 token、并把旧回复说完）。

---

## 6. 视觉层实现

### 6.1 双 video 交叉淡入

```html
<video id="vA" loop muted playsinline preload="auto"></video>
<video id="vB" loop muted playsinline preload="auto"></video>
```

切装时：`vB.src = 新装扮` → `canplay` → 400ms 透明度交叉 → `vA.src = ''` 释放解码。避免单 video 换源时的白屏（FR-043）。

### 6.2 状态叠加

| 状态 | 叠加实现 |
|---|---|
| 待机 | 无（或 `transform: scale(1.000→1.004)` 12s 呼吸） |
| 聆听 | 径向渐变光晕 `opacity .15→.35` 呼吸 + 麦克风图标 |
| 思考 | 光晕加快 + 三点 `animation-delay` |
| 说话 | `scaleY(1 + level*0.004)`，`level` 由 Rust 每 50ms 推送 |

**口型限制**：嘴巴在视频里，无法逐帧控制；`level` 只能让整体轻微起伏。这是 SPEC NG-13 的既定上限，`docs/known-limits.md` 必须写明。

### 6.3 点击穿透（P0 折中）

P0：窗口整体不穿透，但窗口尺寸裁剪到角色包围盒 + 气泡区域，空白透明像素占比 <15%。
P1：全局鼠标监听 + `set_ignore_cursor_events(true/false)` 动态切换，实现真正穿透。

**已知问题**：P0 方案下，窗口透明区域仍会挡住其下方的图标点击。写入 known-limits。

---

## 7. 数据与配置

### 7.1 存储位置

```
%APPDATA%\desktop-companion\
├─ data.db          # SQLite（WAL）
├─ assets\          # 素材（用户可替换）
├─ logs\            # tracing 滚动日志（脱敏）
└─ config.json      # 非敏感设置（不含 Key）
```

Key 走 `keyring`（Windows Credential Manager），service=`desktop-companion`，user=`deepseek`。

### 7.2 迁移

`rusqlite` + 内嵌 `migrations/0001_init.sql`；`PRAGMA user_version` 驱动，启动时事务内执行。

### 7.3 素材导入器

从现有 FRAC 目录批量生成：

```powershell
desktop-companion import --source "D:\...\431960\3828392144" --wardrobe classic
```

读 `catalog.js`（或 `project.json`）→ 每套生成 `assets/looks/<id>/look.json`：

```json
{
  "id": "look-01", "name": "夜色红底", "wardrobe": "classic", "order": 1,
  "kind": "loop", "video": "video.webm", "cover": "cover.jpg",
  "loopStart": 0, "loopEnd": null, "freezeSec": 10.5
}
```

视频以硬链接或复制（同盘硬链接省 930MB），封面从视频首帧或现有 `images/*.jpg` 取。

---

## 8. 延迟落地

对照 SPEC §9.5 的 2100ms 预算，各段实现手段：

| 段 | 实现 |
|---|---|
| 编码 WAV | `hound` 写内存 `Vec<u8>`，60s 上限 1.9MB，40ms 内 |
| 上传 | `reqwest` 连接池复用 + `HTTP/2`；不新建连接 |
| ASR | 松手即发起，不等 VAD 收尾帧 |
| LLM 首 token | system prompt 精简（≤1200 字）；`max_tokens` 限制；不用思考模式 |
| 切句 | 见 §4.3，首句 15 字硬切 |
| TTS 首包 | 首句单独请求；`format=pcm` 免容器解析 |
| 播放 | 首包到即写环，不等整句 |

**可观测**：每段 `Instant::now()` 差值写入 Turn 记录（FR-073 面板直接读表）。

---

## 9. 错误与兜底矩阵

| 场景 | 行为 | 用户感知 |
|---|---|---|
| ASR 超时/5xx | 重试 1 次 → 兜底 | "没听清，再说一次？" |
| ASR 401/402 | 终止 | 设置页红字 + 托盘图标感叹号 |
| LLM 超时 | 重试 1 次 → 兜底 | "我走神了，你刚说什么？" |
| LLM 429 | 不重试 | "等一下，让我缓口气。" |
| TTS 400 审核 | 换更短兜底句重试 1 次 | 正常语音或纯文字 |
| TTS 中途断流 | 丢弃残句，不续播 | 短促停顿后回待机 |
| 无网络 | 启动即检测 | 托盘提示 + 兜底可用 |

兜底台词来自 `assets/fallback/lines.json`（旧壁纸对白抽取，D-16），按场景分组，避免重复（FR-027）。

---

## 10. 打包与分发

- `cargo tauri build` → MSI/NSIS，目标 ≤25MB（不含素材）。
- 首启检测 WebView2：查注册表 `EdgeUpdate\Clients`；缺失则引导下载 Evergreen Bootstrapper（R-1）。
- 不内置任何人物素材（D-3、R-7）；首启若无 `assets/`，提示导入现有壁纸目录。

---

## 11. 里程碑

| 里程碑 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **M0 骨架** | Tauri 工程、透明置顶窗、托盘、单实例、配置与密钥、日志 | 窗口能拖、能隐藏、Key 存进凭据管理器 | 0.5 天 |
| **M1 听得见** | WASAPI 采集 + VAD + WAV + ASR 适配器 + "测试连接" | 说一句，日志出现正确中文 | 1 天 |
| **M2 会说话** | LLM 流 + 情绪解析 + 断句 + TTS 首句 + Rust 播放 + 气泡 + 四态 | 连续 5 轮对话；打断 <300ms；实测 P50 | 1.5 天 |
| **M3 有衣橱** | 素材扫描/导入 + 双 video 交叉 + 网格翻页 + 换装 + 记忆 + 省电 | 121 套可切换；问"我穿的哪套"答对 | 1.5 天 |
| **M4 能交付** | 延迟/成本面板 + 故障注入 + 降级开关 + 打包 | SC-001/005/006/007 全过 | 1 天 |

**总计约 5.5 个工作日**（不含素材人工标注时间，见 SPEC Q-3）。

---

## 12. 测试策略

| 层级 | 方式 |
|---|---|
| 适配器 | `mock.rs` 注入固定流，离线跑完整轮次 |
| 状态机 | 单元测试：误触、打断、取消、审核失败重试 |
| 断句 | 中文标点用例集（含引号、省略号、数字顿号） |
| 集成 | 真 API 冒烟：每次发布前 10 轮 |
| 人工 | 必须真人听、真人打断、真人换装 |

**不做**：把真 API 放进 CI（费钱且不稳定）。

---

## 13. 已知限制（须写入交付说明）

1. 口型不与语音同步，仅整体起伏（供应商无 viseme）。
2. 必须半双工，她说话时你不能插话（无 AEC）。
3. P0 窗口透明区域会挡住下方点击（P1 解决）。
4. ASR 非流式，端到端下限约 2.1s。
5. 语速不可调。
6. 未测项一律标注"未验证"，不得声称流畅或无 bug。
