# 许可与归属说明（LICENSING）

本仓库的 [`LICENSE`](LICENSE) 是标准 MIT 许可证，两类内容的版权主体不同：

| 内容 | 版权主体 | 许可 |
|---|---|---|
| `app/server/bridge.js`、`cmd/*`、`config/*`、`wizard/*`、`app/ui/*`、`build.sh`、`tests/*`（飞牛适配层） | Copyright (c) 2026 chenghongyao | MIT |
| `app/server/memos`（构建时从上游下载的官方二进制，**不随本仓库分发**） | Copyright (c) 2025 Memos（usememos 项目） | MIT |

## 上游项目

- **Memos** — <https://github.com/usememos/memos>（官网 <https://usememos.com>）
- 许可：MIT License，Copyright (c) 2025 Memos
- 本应用内置的二进制来自官方发行版，**未修改**：
  - 版本：`26.10-rc.1`（linux_arm64）
  - 下载：<https://github.com/usememos/memos/releases/download/26.10-rc.1/memos_26.10-rc.1_linux_arm64.tar.gz>
  - tar.gz sha256：`796d85b70e8de58a6bb7fe69b9a10a5942e4936e913249a30fd01c7b6afc15e6`
  - 解出的二进制 sha256：`430084b6b30cbb7538f7ebb0c5fcaa9ec1000d69225aa2e871ab7cc03ae5325a`
  - `build.sh` 会自动下载并校验上面的 sha256

上游许可证全文见 [`app/server/LICENSE-MEMOS`](app/server/LICENSE-MEMOS)，
完整第三方声明见 [`app/server/NOTICE`](app/server/NOTICE)。

## 其他第三方组件

- **Node.js v24** — Apache License 2.0，<https://nodejs.org/>
  本应用以子进程方式调用系统内已安装的 Node.js（依赖应用 `nodejs_v24`），
  未修改、未静态链接其任何代码。

## 商标与名称

“Memos” 名称、品牌与图标归 usememos 项目所有。
**本应用是第三方飞牛打包，不是 usememos 官方发行版**，不得被表述为官方产品。
