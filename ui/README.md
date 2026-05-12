# CDA UI Client

桌面客户端目录，当前先支持 mac 开发与打包，结构已预留跨平台（Windows/Linux）目标。

## 开发启动

1. 在仓库根目录编译核心引擎（供 UI 主进程动态加载）：

```bash
npm run build
```

2. 安装 UI 依赖：

```bash
npm run ui:install
```

3. 启动客户端开发模式：

```bash
npm run ui:dev
```

## 打包

仅打 mac 包：

```bash
npm run ui:dist:mac
```

跨平台目标（后续可在对应系统执行）：

```bash
cd ui && npm run dist:all
```

## 目录说明

- `electron/main.ts`: Electron 主进程，窗口与 IPC，调用 `dist/createDefaultEngine.js`
- `electron/preload.ts`: 安全桥接层，向渲染层暴露 `runTurn/health/onProgress`
- `src/App.tsx`: 客户端对话 UI（消息区、模块状态、token usage、reflect 统计）
- `vite.config.ts`: Vite + Electron 构建入口
