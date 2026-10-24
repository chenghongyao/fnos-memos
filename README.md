# Memos for fnOS

[Memos](https://github.com/usememos/memos) 的飞牛 fnOS 第三方应用包。
内置官方 **26.10-rc.1**（linux_arm64）二进制，未修改。

默认通过飞牛统一网关访问，**不占用任何 TCP 端口**；安装时也可额外开放一个 TCP 端口。

> 本应用为第三方打包，非 usememos 官方发行版。归属与许可见 [LICENSING.md](LICENSING.md)。

## 访问入口

| 入口 | 地址 | 说明 |
|---|---|---|
| 统一网关 | `http://<NAS>:5666/app/Memos` | 飞牛桌面图标走这里，复用 NAS 登录态 |
| TCP 端口（可选） | `http://<NAS>:<端口>/` | 向导里开启后才有，不经过 NAS 登录态 |

两种入口可同时使用。

## 安装

```bash
git clone https://github.com/chenghongyao/fnos-memos.git
cd fnos-memos
./build.sh                                   # 自动下载并校验上游二进制，产物 Memos.fpk
sudo -n appcenter-cli install-fpk "$PWD/Memos.fpk"
```

带选项安装：

```bash
cat > /tmp/memos.env <<'EOF'
enable_port=true
port=8081
host=0.0.0.0
EOF
sudo -n appcenter-cli install-fpk "$PWD/Memos.fpk" --env /tmp/memos.env
```

需要飞牛已安装依赖应用 `nodejs_v24`。

## 向导

| 向导 | 字段 | 说明 |
|---|---|---|
| 安装 / 配置 | `enable_port` | 是否额外开放 TCP 端口（默认 `false`） |
| | `port` | TCP 端口号（默认 `8081`） |
| | `host` | TCP 监听地址（默认 `0.0.0.0`） |
| | `instance_url` | 实例外部地址，OAuth 回调与分享链接用，可留空 |
| 卸载 | `wizard_data_action` | `keep` 保留数据（默认）/ `delete` 删除全部数据 |

配置向导保存后会自动重启应用生效。

## 升级 / 卸载

飞牛的 `install-fpk` 对**任何已安装的同名应用**都会直接跳过（只打印
`Application [Memos] is installed.`，不做任何事，也不看版本号），所以升级要「停 → 卸 → 装」。
数据目录 `/vol1/@appdata/Memos` 卸载时不会被删除：

```bash
sudo -n appcenter-cli stop Memos
sudo -n rm -f /var/apps/Memos/wizard/uninstall     # 见下方说明
sudo -n appcenter-cli uninstall Memos
sudo -n appcenter-cli install-fpk "$PWD/Memos.fpk"
```

卸载（走卸载向导，可选保留或删除数据）：

```bash
sudo -n appcenter-cli uninstall Memos
```

> 包里带 `wizard/uninstall` 时，`appcenter-cli uninstall` 会被拒绝
> （提示 `please uninstall it from Web UI`）。脚本化卸载前先执行：
> `sudo -n rm -f /var/apps/Memos/wizard/uninstall`

## 数据

| 内容 | 路径 |
|---|---|
| 数据库与附件 | `/vol1/@appdata/Memos/data` |
| 运行日志 | `/vol1/@appdata/Memos/info.log` |

卸载默认保留数据；要彻底清理手动执行 `sudo rm -rf /vol1/@appdata/Memos`。

## 目录

```
manifest               应用元信息
app/server/bridge.js   网关 / TCP 双入口桥接
app/server/memos       上游二进制（构建时下载，不入库）
app/ui/config          桌面入口
cmd/                   生命周期脚本（start / stop / status / 安装 / 升级 / 卸载 / 配置）
config/                权限与资源声明
wizard/                安装 / 配置 / 卸载向导
build.sh               打包脚本
tests/                 自检脚本
```

## 排错

```bash
sudo -n appcenter-cli status Memos                       # running
sudo -n tail -30 /vol1/@appdata/Memos/info.log           # 应用日志
curl -s http://127.0.0.1:5666/app/Memos/ | head -c 20    # 未登录返回 invalid token 属正常
curl -s http://<NAS>:<端口>/_gw/health                    # 开了 TCP 端口才有
sudo -n journalctl -t trim_http_cgi --since '-5min' | grep Memos   # 网关注册
```

常见问题：

- **网关页面白屏** → 看浏览器控制台是否有指向站点根的 `/assets/…` 请求。
- **TCP 端口起不来** → `info.log` 里找 `EADDRINUSE`，换个端口。
- **桥接相关的改动** → 属于安装期字段，必须卸载重装才会生效。

## 许可

MIT。适配层 © 2026 chenghongyao，上游 Memos © 2025 Memos。
详见 [LICENSE](LICENSE)、[LICENSING.md](LICENSING.md)、[app/server/NOTICE](app/server/NOTICE)。

上游项目：<https://github.com/usememos/memos>
