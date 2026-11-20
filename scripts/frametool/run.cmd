@echo off
rem Frame extractor launcher (same pattern as start.cmd)
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "DC_VIDEO=D:\Program Files (x86)\Steam\steamapps\workshop\content\431960\3828392144\media\look-01.webm"
set "DC_TIMES=1,3,5,7,9,11"
set "DC_OUT=%~dp0..\..\frames"
set "DC_LOG=%~dp0..\..\frames\extract.log"
"%~dp0..\..\node_modules\electron\dist\electron.exe" "%~dp0." --no-sandbox
endlocal
