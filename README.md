# dsh-desktop

给 DeepSeek Harness 的 Web GUI 加一个 macOS 客户端外壳（Phase 1，本机自用）：

- 双击即启动，**独立原生窗口**（不是浏览器）；
- 自动探测并复用已运行的 `dsh web`，没有就替你拉起；
- 关闭窗口 = 缩到托盘，后台继续跑；
- 会话 / 设置 / 凭据仍复用 `~/.dsh`，与你现在的 GUI 完全一致。

原理：dsh 的 GUI 后端本就是一个只监听 `127.0.0.1:3080` 的本地服务。这个壳只做三件事——启动后端（`node <checkout>/apps/cli/lib/bin.js web --no-open`）、等它就绪、开一个 Electron 窗口加载它。**不改动 dsh 源码。**

## 依赖与构建

- macOS + Node ≥ 22（打包用；运行时后端用 `config.defaults.json` 里的 node 路径）。
- 已构建的 dsh checkout（`apps/cli/lib/bin.js` 与 `apps/web/dist` 存在，即 `pnpm run build` 跑过）。

```sh
npm install                      # 安装 electron + electron-builder
npm run icons                    # （可选）重新生成图标，需 macOS sips/iconutil
npm run dist                     # 产出 release/ 下的 .app 和 .dmg
```

## 使用

- 把 `release/mac*/DeepSeek Harness.app` 拖进「应用程序」，双击打开。
- 首次打开若被 Gatekeeper 拦截（未签名），右键 →「打开」，或执行：
  `xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"`。
- 右上角关窗 = 缩到托盘；托盘菜单「退出」才真正停掉它拉起的后端。

## 配置

默认值在 `config.defaults.json`；如需覆盖，把下面内容写进
`~/.dsh/desktop-config.json`（未打包时也可用环境变量 `DSH_CHECKOUT` / `DSH_PORT` /
`DSH_NODE` / `DSH_BIN` 覆盖）：

```json
{
  "node": "/usr/local/bin/node",
  "checkout": "/Users/kuma/projects/deepseek-harness",
  "bin": "",
  "port": 3080,
  "closeToTray": true,
  "startupTimeoutMs": 30000
}
```

`bin` 留空时按 `checkout/apps/cli/lib/bin.js` 推断；填绝对路径则优先用它。

## 说明 / 边界

- 这是 Phase 1：后端仍依赖你本机的 Node 与 dsh checkout，**不用于分发给别人**。
- 改了 dsh 源码后记得先 `pnpm run build`，否则后端仍是旧产物（与 `pnpm dsh web` 行为一致）。
- 后端日志写到 `~/.dsh/logs/dsh-desktop.log`，排查启动问题看这里。
