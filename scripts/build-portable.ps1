# 构建绿色版：把 Electron 运行时 + 应用代码打成一个可直接运行的文件夹，并压缩成 zip。
# 不依赖 electron-builder，也不需要联网（避免从 GitHub 下载 NSIS 卡住）。
#
# 用法： pwsh -File scripts/build-portable.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$name = 'DesktopCompanion-win64'   # 目录名用英文，避免跨语言环境的路径问题
$zipName = '桌面陪伴-win64'
$out = Join-Path $root "dist\$name"
$zip = Join-Path $root "dist\$zipName.zip"
$electronDist = Join-Path $root 'node_modules\electron\dist'

if (-not (Test-Path $electronDist)) {
  throw "找不到 Electron 运行时：$electronDist（先执行 npm install）"
}

Write-Host "清理旧产物…"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "复制 Electron 运行时（约 357 MB）…"
Copy-Item "$electronDist\*" $out -Recurse -Force

# Electron 默认程序包，留着会在找不到 app 时启动空壳
Remove-Item (Join-Path $out 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue

# 主程序用英文名（跨语言环境、命令行都安全），中文名放在快捷方式上
$exeOld = Join-Path $out 'electron.exe'
$exeNew = Join-Path $out 'DesktopCompanion.exe'
if (Test-Path $exeOld) { Rename-Item $exeOld 'DesktopCompanion.exe' }

Write-Host "放入应用代码…"
$appDir = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
foreach ($item in 'electron', 'renderer', 'assets', 'package.json') {
  $src = Join-Path $root $item
  if (Test-Path $src) {
    Copy-Item $src $appDir -Recurse -Force
  }
}

# 应用图标（ICO 用 PNG 载荷，Vista 以后都支持）
$ico = Join-Path $appDir 'assets\app.ico'
$png = Join-Path $root 'assets\icon-256.png'
if ((Test-Path $png) -and -not (Test-Path $ico)) {
  $pngBytes = [System.IO.File]::ReadAllBytes($png)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)
  $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0); $bw.Write([Byte]0)
  $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$pngBytes.Length)
  $bw.Write([UInt32]22)
  $bw.Write($pngBytes)
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($ico, $ms.ToArray())
  $bw.Dispose(); $ms.Dispose()
}

Write-Host "生成启动脚本与快捷方式…"
# 本机 Chromium 沙箱不可用，必须带 --no-sandbox；参数写在脚本与快捷方式里
$cmdFile = Join-Path $out '启动（备用）.cmd'
@"
@echo off
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
start "" "%~dp0DesktopCompanion.exe" --no-sandbox
"@ | Set-Content -Path $cmdFile -Encoding ASCII

$lnk = Join-Path $out '桌面陪伴.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $exeNew
$sc.Arguments = '--no-sandbox'
$sc.WorkingDirectory = $out
$sc.IconLocation = "$ico,0"
$sc.Description = '桌面陪伴'
$sc.Save()

# 说明文件
@"
桌面陪伴（绿色版）

启动方式：双击「桌面陪伴.lnk」
  - 必须带 --no-sandbox 参数启动，快捷方式里已经带好，请不要直接双击 exe
  - 如果快捷方式失效，双击「启动（备用）.cmd」

首次启动：
  - 会自带一套装扮「夜色红底」，直接就能看到画面
  - 想用你自己的 121 套装扮：在程序目录执行
      node scripts\import-looks.js "你的壁纸目录"
    然后重启程序

数据位置：
  %LOCALAPPDATA%\DesktopCompanion\（config.json / looks.json / logs）

API Key：
  在程序面板里粘贴 sk- 开头的 DeepSeek Key，会加密保存在系统里。
"@ | Set-Content -Path (Join-Path $out '使用说明.txt') -Encoding UTF8

# 安全门禁：绝对不允许把用户数据（API Key、配置、日志、装扮清单）打进分发包
$leak = Get-ChildItem $out -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -in @('secret.bin', 'config.json', 'looks.json', 'main.log') -or
  $_.FullName -match '\\data\\'
}
if ($leak) {
  $list = ($leak | Select-Object -First 5 | ForEach-Object { $_.FullName }) -join "`n  "
  throw "打包目录里出现了用户数据，已中止：`n  $list"
}
Write-Host "安全检查通过：没有用户数据被打包 ✓"

Write-Host "压缩 zip（这一步较慢）…"
if (Test-Path (Join-Path $env:SystemRoot 'System32\tar.exe')) {
  & tar.exe -a -c -f $zip -C (Join-Path $root 'dist') $name
} else {
  Compress-Archive -Path $out -DestinationPath $zip -CompressionLevel Optimal
}

$size = (Get-Item $zip).Length / 1MB
$dirSize = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("完成：{0}" -f $zip)
Write-Host ("  文件夹 {0:N0} MB / zip {1:N0} MB" -f $dirSize, $size)
