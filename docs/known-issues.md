# 已知问题

## KI-001 · 本机 WebView2 运行时崩溃，导致 Tauri 窗口无法渲染

| 项 | 内容 |
|---|---|
| 状态 | **阻塞中（环境问题，非代码问题）** |
| 发现时间 | 2026-11-18 |
| 影响 | M0 起所有依赖 WebView2 的验证；M1–M4 全部受影响 |
| 严重度 | 高（Tauri 方案在当前机器上无法运行） |

### 现象

应用启动后 Tauri 主窗口能创建、标题正确（「桌面陪伴」），但 WebView2 子进程崩溃，弹出：

> Microsoft Edge WebView2 已停止工作 —— 出现了一个问题，导致程序停止正常工作。

窗口内容区为空白（白色），`setup` 闭包内的日志一行都没写入。

截图：`docs/assets/webview2-crash.png`

### 证据

1. 直接运行运行时主程序即崩溃：

   ```powershell
   & "C:\Program Files (x86)\Microsoft\EdgeWebView\Application\157.0.4341.60\msedgewebview2.exe" --version
   # 退出码 13，无输出
   ```

2. 系统事件日志（Application）反复记录：

   ```
   错误应用程序名称: msedgewebview2.exe，版本: 157.0.4341.60
   错误模块名称:     msedge.dll，版本: 157.0.4341.60
   异常代码:         0x80000003          # STATUS_BREAKPOINT（Chromium CHECK 失败）
   错误偏移量:       0x000000000393ec00
   ```

3. 对照实验（已排除的因素）：

   | 假设 | 实验 | 结论 |
   |---|---|---|
   | 代码问题 | 换成最朴素窗口（无透明/无置顶/有边框） | 同样崩溃，排除 |
   | 单实例插件 | 移除插件后重启 | 同样崩溃，排除 |
   | 我的执行环境（作业对象限制） | 用任务计划程序以交互用户身份启动 | 同样崩溃，排除 |
   | WebView2 数据目录权限 | 显式指定 `E:\dp_work\wv2data`；并在 `%LOCALAPPDATA%` 手工验证可写 | 可写，排除 |
   | 运行时文件损坏 | 卸载重装、下载 **离线 Standalone 安装包**（205 MB）重装、把运行时目录改名后重新解压（918 个文件） | 全部无效 |
   | 窗口透明/GPU | `--no-sandbox`、`--disable-gpu`、`--disable-software-rasterizer` 组合 | 仅改变错误形态（E_ACCESSDENIED → E_UNEXPECTED），未解决 |
   | 安全软件注入 | `AppInit_DLLs` 为空；未发现 360/火绒/杀软进程 | 排除 |
   | Edge 组策略 | `HKLM\SOFTWARE\Policies\Microsoft\Edge` 不存在 | 排除 |
   | 系统不支持 Win10 | 官方文档：Edge 与 WebView2 **在 Win10 22H2 上支持到 2028 年 10 月** | 排除 |

4. 关键对照：**同一台机器上 Edge 浏览器（同为 157.0.4341.60）正常启动**（11 个进程存活，能开 about:blank）。

5. **二进制完全一致**：两处的 `msedge.dll` 大小（341.6 MB）、时间戳（2026-11-13 22:02:30）、SHA256 均相同。

   | 位置 | SHA256 前 16 位 |
   |---|---|
   | Edge\Application\157.0.4341.60\msedge.dll | `E4C51CDA4E2BC9F3` |
   | EdgeWebView\Application\157.0.4341.60\msedge.dll | `E4C51CDA4E2BC9F3` |

   → 同一份二进制在 Edge 里正常、在 WebView2 宿主里崩，**问题不在文件完整性，而在宿主的启动上下文**。

6. 已排除：`msedge_elf.dll`、`icudtl.dat`、`v8_context_snapshot.bin`、`vk_swiftshader.dll` 均存在。

7. 管理员权限假设：当前 shell 为 `High Mandatory Level`（提权）。用任务计划 `/rl limited`（不提权）启动后**仍然崩溃**，故非权限问题。

8. 系统修复：`DISM /Online /Cleanup-Image /RestoreHealth` 报告"还原操作已成功完成"，`sfc /scannow` 未发现完整性冲突；修复后重测**仍然崩溃**。
   （日志：`docs/repair-log.txt`）

### 当前结论

WebView2 在这台机器上**任何配置下都无法初始化**。已穷尽以下手段：
| # | 尝试 | 结果 |
|---|---|---|
| 1 | 卸载 + 离线 Standalone 包重装 + 目录改名重解压（918 文件） | 无效 |
| 2 | `DISM /RestoreHealth`（报告成功）+ `sfc /scannow`（无冲突） | 无效 |
| 3 | 透明/朴素窗口切换、移除单实例插件 | 无效 |
| 4 | 任务计划 `/rl highest` 与 `/rl limited` | 均无效 |
| 5 | **PsExec `-l`（Low 完整性，已确认降权生效）** | 无效 → **排除提权因素** |
| 6 | 官方 Fixed Version 运行时 **156**（295 MB，微软 CDN） | 无效 → **排除版本因素** |
| 7 | `--no-sandbox` / `--disable-gpu` / `--disable-software-rasterizer` | 只改变错误码（E_ACCESSDENIED → E_UNEXPECTED） |
| 8 | 利用保护（Exploit Protection）系统级策略 | 未设置 |
| 9 | IFEO / AppInit_DLLs / ASR 规则 / 杀软 | 均无 |
| 10 | 二进制哈希对比（Edge vs WebView） | 完全相同 |
| 11 | 重启电脑 | 无效 |

**唯一正常的是 Edge 浏览器**（同一份 `msedge.dll`、同一版本）。差异只可能来自 `msedgewebview2.exe` 这一宿主二进制的启动路径。

结论：这是本机环境级故障，靠配置/重装运行时/系统修复组件都无法解决。要在这台机器上用 WebView2，实际可行的只有重置或重装 Windows。

### 待尝试的解决方向（按代价排序）

| # | 方案 | 预估 | 风险 |
|---|---|---|---|
| 1 | `DISM /Online /Cleanup-Image /RestoreHealth` + `sfc /scannow` 修复系统组件 | 20–40 分钟 | 低，可能无效 |
| 2 | 检查并安装挂起的 Windows 累积更新（WebView2 依赖部分系统 API） | 视情况 | 低 |
| 3 | 安装 **Fixed Version** 版 WebView2（指定旧版本 cab，随应用分发，不走 Evergreen） | 需下载 ~150 MB 并改打包方式 | 中；包体从 25 MB 涨到 ~180 MB |
| 4 | 换渲染方案：放弃 WebView2，改纯 Rust `egui`/`iced` 自绘 | 工期 ×3（视频解码/排版/动画自建） | 高 |
| 5 | 在另一台机器上验证代码（确认代码无误，仅本机环境问题） | 10 分钟 | 无 |

**建议顺序**：先做 5（确认代码），再做 1（低成本修复），仍失败则评估 3。

### 不受影响的验证

以下部分不依赖 WebView2，已确认可用：

- Rust 全量编译（Tauri + 托盘 + 单实例 + keyring + tracing + rusqlite 待接）通过，产物 15.9 MB
- 前端 `pnpm build`（tsc + vite）通过
- `cargo build` / `pnpm tauri build --debug --no-bundle` 退出码 0
- 窗口对象创建成功（标题、会话、尺寸正确）

### 关联

- 规格：NFR-009（仅 Windows）、R-1（WebView2 运行时缺失）
- 任务：T0-01 ~ T0-08 代码完成，运行时验收被本问题阻塞

### 后续（2026-11-18 结案）

改用 **Electron** 后定位到同一根因，并找到可用的绕过方式，见 KI-002。KI-001 的结论保留作为记录：WebView2 路线在本机不可用。

---

## KI-002 · Chromium 沙箱与用户配置目录在本机不可用（已绕过）

| 项 | 内容 |
|---|---|
| 状态 | **已绕过（有可运行方案）** |
| 发现时间 | 2026-11-18 |
| 影响 | 所有 Chromium 系嵌入（WebView2、Electron） |
| 严重度 | 高，但已有稳定规避手段 |

### 现象

Electron 启动后 `app.whenReady()` 不触发，或启动即静默退出，无错误输出。

### 根因（两个独立问题）

**1. Chromium 沙箱无法初始化**

| 条件 | 结果 |
|---|---|
| 默认参数 | 进程静默退出，`main` 都不加载 |
| `--no-sandbox` | `main` 加载，但仍卡在 ready |
| `--no-sandbox` + 显式 `--user-data-dir` | **READY ✓** |

PsExec `-l`（Low 完整性）下同样失败，故与提权无关，是沙箱本身在该机器上不可用。

**2. 默认用户配置目录不可写**

- Electron 默认 `userData` 在 `%APPDATA%`（Roaming），本机创建时阻塞或返回 `EPERM`。
- 同样现象也解释了 Tauri 版为何 `%APPDATA%\desktop-companion` 从未出现。
- Chromium 子进程对 `%LOCALAPPDATA%\DesktopCompanion` 下的 `GPUPersistentCache`、`Network`、`Code Cache` 也返回 `ACCESS DENIED (0x5)`。

### 采用的绕过（已写入代码）

| 问题 | 处理 | 位置 |
|---|---|---|
| 沙箱 | 启动参数加 `--no-sandbox`；`npm start` 与 `start.cmd` 已带 | `start.cmd`、`package.json` |
| 用户配置目录 | `app.setPath('userData', <应用目录>/data)`，完全避开 AppData | `electron/main.js` 顶部 |
| 日志失败不致命 | `logger.init` 包 try/catch | `electron/main.js` |
| 单实例锁失败不退出 | 锁拿不到时仅告警，不 `app.quit()`（待改） | `electron/main.js` |

### 验证结果

启动后 4 个 Electron 进程、窗口标题「桌面陪伴」、`data/` 下生成 `config.json` 与 `logs/main.log`，界面正常渲染（版本、Electron 45.3.4、Chromium 156、API Key 未设置、配置路径均显示正确）。

### 遗留风险

- `--no-sandbox` 关闭了渲染进程沙箱。当前界面只加载本地 HTML 且带 CSP，风险可控，但**发布前应评估**；在正常机器上可去掉该参数。
- `userData` 放在应用目录，卸载时不会自动清理，需在安装器/文档中说明。

