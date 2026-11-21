# Mermaid 渲染器

把 Mermaid 源码渲染成 PNG。用本机 Electron 里的 Chromium 渲染，再用 canvas 栅格化，不依赖 mermaid-cli。

## 用法

```powershell
cd scripts\mermaid-render
npm install mermaid --registry=https://registry.npmmirror.com
& "<项目>\node_modules\electron\dist\electron.exe" . --no-sandbox
```

输出到 `docs/assets/`，图源在 `diagrams.js` 里改。

## 注意

- 必须带 `--no-sandbox`，且 app 路径要放在参数前面
- `userData` 必须指到可写目录（本机 %APPDATA%/%TEMP% 会被拒绝）
- 关了 `htmlLabels`：foreignObject 在 canvas 栅格化时会丢内容
