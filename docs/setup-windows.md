# Windows 开发环境安装文档（最新版）

| 项 | 内容 |
|---|---|
| 适用项目 | `desktop-companion`（SPEC-001 v1.3 / PLAN v1.0） |
| 技术栈 | Rust + Tauri 2 + 系统 WebView2 + TypeScript |
| 目标机器 | Windows 10 1809+ / Windows 11 x64 |
| 文档版本 | v2.1（2026-11-16）— 按系统版本区分 VS 2022 / 2026 |
| 完成标准 | `pnpm tauri dev` 能起出透明空窗；`cargo build` 无链接错误 |

**总共 4 项必装 + 1 项确认。约 1 小时，占盘 7–12 GB。**

---

## 0. TL;DR：命令版

**先看清楚你的系统版本**，这一步选错会白装：

```powershell
winver   # 弹出对话框看 "Windows 10" 还是 "Windows 11"
```

| 你的系统 | 装哪个 | 原因 |
|---|---|---|
| **Windows 11** | VS **2026** Build Tools | 2026 只支持 Win11 / Server 2019+ |
| **Windows 10** | VS **2022** Build Tools | **2026 不支持 Windows 10**，必须用 2022 |

### Windows 11 用这条

```powershell
winget install -e --id Microsoft.VisualStudio.BuildTools --override `
  "--passive --wait --norestart --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100"
```

### Windows 10 用这条

```powershell
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override `
  "--passive --wait --norestart --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows10SDK.19041"
```

### 其余步骤（两个系统通用）

```powershell
winget install Rustlang.Rustup
rustup default stable-msvc
rustup component add rustfmt clippy

winget install OpenJS.NodeJS.LTS
winget install Git.Git
npm i -g pnpm
```

镜像配置见第 6 节，验证脚本见第 8 节。

---

## 1. 必装清单

| # | 工具 | 版本 | 用途 |
|---|---|---|---|
| 1 | **Visual Studio 生成工具**（Build Tools） | **Win11 → 2026；Win10 → 2022** | 提供 `link.exe` + Windows SDK，Rust 链接必需 |
| 2 | **Rust（rustup）** | stable ≥ 1.77 | 主语言 |
| 3 | **Node.js** | 22 LTS 或更高 | 前端构建、Tauri CLI |
| 4 | **Git** | 任意近期 | 依赖与版本管理 |

> **关键前提**：VS 2026 的受支持操作系统只有 Windows 11 与 Windows Server 2019/2022/2025，**不包含 Windows 10**（[官方系统要求](https://learn.microsoft.com/zh-cn/visualstudio/releases/2026/vs-system-requirements)）。Windows 10 用户必须装 VS 2022，否则会装不上或装出不可用状态。
>
> 版本依据：Rust 官方支持 Visual Studio 2017 及以后（[rustup 文档](https://rust-lang.github.io/rustup/devel/installation/windows-msvc.html)），因此 VS 2022 完全够用，不必为 2026 升级系统。

---

## 2. 安装 Build Tools（重点：别勾工作负载）

完整"使用 C++ 的桌面开发"工作负载约 **4–7 GB**，绝大部分用不到（ATL、CMake、诊断工具、x86/ARM64 库）。Rust 只需要两样东西：

| 组件 | 作用 |
|---|---|
| **MSVC 生成工具（x64/x86）** | `link.exe`、CRT 导入库 |
| **Windows SDK** | `kernel32.lib` 等系统导入库 |

具体勾哪个版本，取决于你的系统（见 2.1）：

| 系统 | MSVC 组件名 | SDK 组件名 |
|---|---|---|
| Windows 11 | MSVC Build Tools v14.50 或更新 | Windows 11 SDK (10.0.26100) |
| **Windows 10** | **MSVC v143 - VS 2022 C++ x64/x86 生成工具** | **Windows 10 SDK (10.0.19041)** |

### 2.1 GUI 装法（推荐，不受组件 ID 变动影响）

1. 下载并运行 [Visual Studio 生成工具](https://visualstudio.microsoft.com/downloads/)（按系统选 2022 或 2026）；
2. 切到 **"单个组件"** 标签页，**不要**勾任何"工作负载"；
3. 只勾这两项：

   | 你的系统 | 勾选 |
   |---|---|
   | Windows 11 | MSVC v14.50 或更新（x64/x86） + Windows 11 SDK (10.0.26100) |
   | **Windows 10** | **MSVC v143 - VS 2022 C++ x64/x86 生成工具** + **Windows 10 SDK (10.0.19041)** |

4. 可改安装位置到 D 盘（C 盘紧张时建议）；
5. 装完约 **2.0–3.0 GB**。

> Windows 10 也可以装 Windows 11 SDK (22621)，但没必要冒险——SDK 版本对纯 Rust 代码没有影响，19041 最稳。

### 2.2 静默装法

**Windows 11：**

```powershell
winget install -e --id Microsoft.VisualStudio.BuildTools --override `
  "--passive --wait --norestart --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100"
```

**Windows 10：**

```powershell
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override `
  "--passive --wait --norestart --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows10SDK.19041"
```

参数说明：

- `-e` = 精确匹配包 ID（两个包的 ID 不同：`Microsoft.VisualStudio.BuildTools` 是 2026，`Microsoft.VisualStudio.2022.BuildTools` 是 2022）；
- `--wait --norestart` = 等待装完、不自动重启（漏了会少装组件）；
- `--passive` = 显示进度但不需点确认；
- **切勿加 `--includeRecommended`** —— 那就是 4–7 GB 的来源。

或用 `.vsconfig`（微软官方推荐的脚本化方式，可精确复现）：

```json
{
  "version": "1.0",
  "components": [
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "Microsoft.VisualStudio.Component.Windows10SDK.19041"
  ]
}
```

```powershell
# Windows 10：用 17 系列安装器
Invoke-WebRequest https://aka.ms/vs/17/release/vs_buildtools.exe -OutFile vs_buildtools.exe
.\vs_buildtools.exe --passive --wait --norestart --config .\.vsconfig --installPath "D:\VS"
```

> 组件 ID 会随版本变化；报"未识别的组件"就改用 GUI 勾选。`--installPath` 可改到 D 盘。

### 2.3 装完瘦身（再省 0.5–1.5 GB）

```powershell
# 管理员 PowerShell；路径按你的实际安装位置改
$vc = "D:\VS\VC\Tools\MSVC"
Get-ChildItem $vc | ForEach-Object {
  Remove-Item "$($_.FullName)\lib\x86"     -Recurse -Force -EA SilentlyContinue
  Remove-Item "$($_.FullName)\lib\arm64"   -Recurse -Force -EA SilentlyContinue
  Remove-Item "$($_.FullName)\lib\spectre" -Recurse -Force -EA SilentlyContinue
  Remove-Item "$($_.FullName)\atlmfc"      -Recurse -Force -EA SilentlyContinue
}
```

> VS 安装器"修复"会把这些文件装回来，属正常，不影响构建。

### 2.4 想再省？先看清代价

| 方案 | 空间 | 结论 |
|---|---|---|
| 只用 MinGW（`-gnu` 工具链） | ~150 MB | ✗ **不可行**：Tauri 不支持 `-gnu`，WebView2 的 `.lib` 链不上 |
| 改用纯 Rust `egui` + MinGW | ~150 MB | △ 可行，但视频解码/排版/动画全自建，工期 ×3 |
| MSVC 最小安装 | ~2 GB | ✓ 唯一能保住 Tauri 的路 |

**MSVC 不是"能省"的依赖，而是 Windows 上 Rust 链接的必需品；能省的只有组件数量，2 GB 是底线。**

---

## 3. 安装 Rust

```powershell
rustup default stable-msvc
rustup component add rustfmt clippy
rustup target list --installed    # 必须看到 x86_64-pc-windows-msvc
```

三个要点：

- **必须 `-msvc`**，不能用 `-gnu`（与 WebView2、MSVC 库不兼容）；
- `rustup-init` 会主动提议"顺便装 VS 依赖"，但那样装的是 **Community 完整版**（20 GB+）。**选择 No**，自己按第 2 节装 Build Tools。
- 装完 `rustc -V` 应显示 `rustc 1.8x` 以上。

---

## 4. 安装 Node 与包管理器

```powershell
node -v      # v22.x 或更高
npm i -g pnpm
pnpm -v
```

用 pnpm 而非 npm：Tauri 前端依赖树深，pnpm 装得快、占盘小一半。

---

## 5. 确认 WebView2（通常已自带）

Win11 与更新过的 Win10 一般都内置。它是 Tauri 的运行时依赖，缺了表现为**启动白屏或直接退出**。

- 用第 8 节脚本检测；
- 缺失时装 [Evergreen Bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/)。

---

## 6. 国内网络：镜像配置（强烈建议）

不配的话，首次 `cargo build` 与 `tauri build` 大概率卡在拉依赖或下载 NSIS 上。

### 6.1 Rust：`%USERPROFILE%\.cargo\config.toml`

```toml
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[registries.rsproxy]
index = "https://rsproxy.cn/crates.io-index"

[net]
git-fetch-with-cli = true
```

### 6.2 rustup：系统环境变量

```
RUSTUP_DIST_SERVER = https://rsproxy.cn
RUSTUP_UPDATE_ROOT = https://rsproxy.cn/rustup
```

### 6.3 npm

```powershell
npm config set registry https://registry.npmmirror.com
```

---

## 7. 可选工具（不阻塞开发）

| 工具 | 用途 | 安装 |
|---|---|---|
| ffmpeg / ffprobe | 抽封面帧、转码、探测时长分辨率（M3 需要） | `winget install Gyan.FFmpeg` |
| DB Browser for SQLite | 直接查看记忆库与轮次表 | `winget install DBBrowserForSQLite.DBBrowserForSQLite` |
| cargo-watch | Rust 改动自动重编 | `cargo install cargo-watch` |
| PotPlayer / VLC | 听 TTS 产物、验循环接缝 | `winget install Daum.PotPlayer` |
| Windows Terminal | 多标签跑 dev server 与日志 | `winget install Microsoft.WindowsTerminal` |

---

## 8. 验证脚本（装完全部跑一遍）

```powershell
$fail = 0
function Chk($label, $ok, $detail) {
    if ($ok) { Write-Host ("  [OK]   {0,-14} {1}" -f $label, $detail) -ForegroundColor Green }
    else     { Write-Host ("  [FAIL] {0,-14} {1}" -f $label, $detail) -ForegroundColor Red; $script:fail++ }
}

Write-Host "`n== 语言与包管理 ==" -ForegroundColor Cyan
$v = (rustc -V 2>$null);      Chk 'rustc'  ($v -match '^rustc 1\.')      $v
$v = (cargo -V 2>$null);      Chk 'cargo'  ($v -match '^cargo 1\.')      $v
$v = (rustup show active-toolchain 2>$null); Chk 'rustup 工具链' ($v -match 'msvc') $v
$v = (node -v 2>$null);       Chk 'node'   ($v -match '^v(2[0-9]|[3-9][0-9])\.') $v
$v = (pnpm -v 2>$null);       Chk 'pnpm'   ($v -match '^\d+\.')         $v
$v = (git --version 2>$null); Chk 'git'    ($v -match 'git version')    $v

Write-Host "`n== MSVC 工具链 ==" -ForegroundColor Cyan
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
    $p = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    Chk 'Build Tools' ([bool]$p) $(if($p){$p}else{'已装安装器，但缺少 VC.Tools.x86.x64 组件'})
    if ($p) {
        $tv = Join-Path $p 'VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt'
        $ver = if (Test-Path $tv) { (Get-Content $tv -Raw).Trim() } else { '?' }
        $link = Join-Path $p "VC\Tools\MSVC\$ver\bin\Hostx64\x64\link.exe"
        Chk 'link.exe' (Test-Path $link) $(if(Test-Path $link){"MSVC $ver"}else{"找不到 $link"})
        $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Lib'
        $sdkv = if (Test-Path $sdk) { (Get-ChildItem $sdk -Directory | Sort-Object Name -Desc | Select-Object -First 1).Name } else { $null }
        Chk 'Windows SDK' ([bool]$sdkv) $sdkv
    }
} else {
    Chk 'Build Tools' $false '找不到 vswhere（Build Tools 未安装）'
}

Write-Host "`n== 运行时 ==" -ForegroundColor Cyan
$keys = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$wv = $null
foreach ($k in $keys) { $r = Get-ItemProperty $k -EA SilentlyContinue; if ($r.pv) { $wv = $r.pv; break } }
Chk 'WebView2' ([bool]$wv) $(if($wv){$wv}else{'缺失：装 Evergreen Bootstrapper'})

Write-Host "`n== 可选 ==" -ForegroundColor Cyan
$ff = Get-Command ffmpeg -EA SilentlyContinue
Chk 'ffmpeg' ([bool]$ff) $(if($ff){'已装'}else{'未装（M3 素材导入才需要）'})

Write-Host ("`n结论：{0}" -f $(if($fail -eq 0){'全部通过，可以开工'}else{"$fail 项未通过"})) `
  -ForegroundColor $(if($fail -eq 0){'Green'}else{'Red'})
```

**全绿 → 告诉我，我开 M0。**

---

## 9. 确认不装的东西

| 工具 | 为什么不用 |
|---|---|
| Python | 本项目无 Python 依赖（素材导入器用 Rust 写） |
| Java / JDK | 与 Tauri 无关 |
| Android Studio / SDK | 只做 Windows 桌面 |
| CUDA | 视频用 WebView2 硬解，不做本地推理 |
| Visual Studio 完整版 | Build Tools 够用，省 20 GB |
| WiX / NSIS | `tauri build` 首次会自动下载 |
| Docker / WSL | 无跨平台构建需求 |

---

## 10. IDE 与工具链是两层东西

本项目里**我们从不打开 Visual Studio**，只用它提供的编译器和链接器。

| 层 | 作用 | 能否替换 |
|---|---|---|
| **工具链**：rustc / cargo / `link.exe` / SDK / WebView2 | 把代码变成 .exe | ✗ 只能选 MSVC 或 MinGW |
| **IDE**：VS Code、RustRover、Neovim | 写代码、跳转、调试 | ✓ 随便选，不影响构建 |

**RustRover 属于第二层**，内置的是 rustup 调用与 LLDB 调试，**不含 MSVC 链接器与导入库**。装了它仍然要装 Build Tools。

| IDE | 磁盘 | 授权 | 备注 |
|---|---|---|---|
| VS Code + rust-analyzer | ~500 MB | 免费 | 最省，推荐 |
| RustRover | ~2.5–3.5 GB（含 JBR 与索引缓存） | 个人非商业免费 | Tauri 支持开箱，调试顺手 |
| Neovim + rust-analyzer | ~100 MB | 免费 | 需自己配 |

> 想省磁盘，IDE 选 VS Code；两者都不能省掉那 2 GB 的 MSVC。

---

## 11. 五个容易踩的坑

| 坑 | 症状 | 处理 |
|---|---|---|
| **Windows 10 强行装 VS 2026** | 安装程序拒绝安装，或装完缺组件 | 改用 VS **2022** Build Tools（`Microsoft.VisualStudio.2022.BuildTools`） |
| 用错 winget 包 ID | `winget` 报找不到包 | Win11 是 `Microsoft.VisualStudio.BuildTools`；Win10 是 `Microsoft.VisualStudio.2022.BuildTools` |
| 项目路径含中文或空格 | `link.exe` 找不到、编码错误 | 工程放纯英文短路径，如 `D:\dev\companion`（当前 `E:\dp_work` 可用） |
| 未开长路径支持 | `path too long` | 管理员执行 `Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" LongPathsEnabled 1` 后重启 |
| 安装器路径变化导致 rustc 找不到链接器 | `link.exe not found` | 用 `vcvars64.bat` 初始化终端，或把 `VC\Tools\MSVC\<ver>\bin\Hostx64\x64` 加进 PATH |
| 用了 `-gnu` 工具链 | 链接 WebView2 时报缺库 | `rustup default stable-msvc` 切回来 |
| 没配镜像 | `cargo build` 长时间卡在 Downloading | 按第 6 节配 rsproxy |

---

## 12. 磁盘与时间

| 项 | 占用 |
|---|---|
| Build Tools 最小安装（+ 瘦身） | 2.0–3.0 GB → ~1.5 GB |
| Rust 工具链 + 首次构建缓存 | 3–6 GB |
| Node + pnpm store | 1–2 GB |
| 素材（现有 121 套） | ~1 GB |
| **合计** | **约 7–12 GB** |

耗时：下载安装约 40–60 分钟（Build Tools 最久）；首次 `pnpm tauri dev` 编译 3–8 分钟。

---

## 13. 就绪后我会做什么

1. 生成 `src-tauri` 工程骨架（Tauri 2 + Vite + TS）；
2. 起透明置顶窗 + 托盘 + 单实例；
3. 先跑一次 `cargo build` 确认链接器可用（不等写完几千行才发现链不上）；
4. 你确认窗口能拖动、托盘能退出 → 进 M1 音频链路。

M0 不需要 API Key，可以立刻开始。
