@echo off
rem 开发启动脚本：清掉可能存在的 ELECTRON_RUN_AS_NODE，避免 Electron 以纯 Node 模式运行。
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_ENABLE_LOGGING="
"%~dp0node_modules\electron\dist\electron.exe" . --no-sandbox %*
endlocal
