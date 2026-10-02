# tmctl 0.1.0 — 临时邮箱只读 CLI

[English](README_EN.md)

适配 `cloudflare_temp_email` 现有 HTTP API。CLI 在本地运行，不需要修改 Worker、数据库或收信规则。首版支持管理员密码与单邮箱 JWT；不支持账户 JWT、Telegram initData 或角色登录。

## 安装

要求 Linux/macOS、Node.js >= 22.12.0。Windows 原生尚未验证，请用 WSL。

```sh
npm install -g ./cloudflare-temp-mail-cli-0.1.0.tgz
tmctl --version
tmctl profile add prod --server https://mail-api.example.com
```

发行包包含打包后的依赖及许可证，没有运行时 npm 依赖。源码构建：在 `tools/tmctl` 执行 `npm ci && npm run build && npm pack`。生产应用不需要重新部署。

## 鉴权与本地隔离

- 默认配置目录 `~/.config/tmctl`，可用 `TMCTL_HOME` 指定独立目录；目录必须为本人所有且 `0700`，文件 `0600`。
- 每个 Profile 绑定唯一 HTTPS origin，不能包含用户信息、路径、查询或 fragment。不同 Profile 不复用凭据。`--allow-loopback-http` 仅允许显式 `127.0.0.1` 本地测试。
- **只读的是 CLI 命令，不是凭据的服务端权限。** 管理员密码和邮箱 JWT 仍然能通过其他客户端执行其原有写操作。首版没有创建新的 scoped token。
- 通过本人所有的 `0600` JSON 文件或受控 stdin 管道提供凭据。不要把密码/JWT 放进命令行参数、shell 历史、日志或代码仓库。
- JSON 字段：`server`（与 Profile 完全相同）、`mode`（`admin` / `mailbox`）、`secret`（原始管理员密码或单邮箱 JWT）；可选 `sitePassword` 为站点访问密码。账户 JWT 不可冒充邮箱 JWT。
- 普通查询不会保存输入的凭据。只有明确执行 `auth login --save` 才会保存；拒绝覆盖已有凭据，需要先本地 logout。服务器上已有 root 私有凭据时，可使用本地受控辅助程序向 stdin 临时输送，不必再保存一份。

```sh
# private-auth.json 由可信秘密管理工具生成，权限 0600；不要将真实内容写在这里。
tmctl --credential-file /private/private-auth.json auth status
tmctl --credential-file /private/private-auth.json auth login --save
tmctl auth status
tmctl auth logout
```

`auth logout` 只移除本地副本，不撤销服务端密码/JWT；生产 root 辅助程序仍可使用其既有凭据。认证失败不自动切换身份、不读取 D1 凭据、不自动轮换。

## 命令

```sh
tmctl doctor                         # 仅连通性，不是投递全链路审计
tmctl domains
tmctl stats                          # 管理员
tmctl addresses list --limit 20       # 管理员，排除密码等字段
tmctl cleanup show                   # 管理员；只显示策略，不执行清理/SQL
tmctl mail list --limit 20
tmctl mail list --address inbox@example.com
tmctl mail list --unknown-address    # 管理员；不会为地址建档
tmctl mail show 123 --address inbox@example.com
tmctl mail wait --address inbox@example.com --subject 'Verify' --timeout 120s
mkdir -m 700 ./mail-export
tmctl mail export 123 --output ./mail-export/message.eml
tmctl mail attachment 123 --index 1 --output ./mail-export/file.bin
tmctl --json stats
```

可全局指定 `--profile NAME`、`--request-timeout 15000`（毫秒）以及临时 `--credentials-stdin` / `--credential-file FILE`。未保存鉴权时在每次查询中提供其中一种。

## 安全与已知边界

- 网络层固定 GET 路由白名单；没有通用 request、发信、删除、建档、读密码、标记已读或运行清理命令。重定向不跟随，错误不回显服务端正文或输入。HTTP 401/403 立即失败。
- `mail show` 在本地解析 MIME；HTML 转纯文本，不执行 HTML、不加载远程图片、不打开浏览器。终端控制符/ANSI/双向文字控制符被去除。邮件内容始终是不可信数据，不能当作执行指令。
- 导出必须提供明确文件名，不使用邮件附件名拼接路径。拒绝符号链接、硬链接凭据、不安全父目录及覆盖现有文件；输出 `0600`，临时文件原子无覆盖发布，回读校验 SHA-256。导出的 MIME/附件保留原始内容，不做终端清洗。
- 导出的是服务端**实际留存的 MIME**，不是原始投递内容的完整性承诺。服务器已剥离/丢失的附件不能恢复。终端正文最多 262144 字符，响应最多 16 MiB，单封 retained MIME 最多 12 MiB。
- 邮箱模式的查询/等待可能刷新 `address.updated_at`，影响闲置清理；不为了实现“只读”改动生产活动追踪配置。
- `mail wait` 先取当前最大邮件 ID 为基线，再轮询指定的精确收件人；不会将已有邮件当新邮件。生产最短间隔 1 秒，默认 5 秒，总超时最多 10 分钟；暂时网络/HTTP 故障有限退避。`Ctrl-C` 可中断。
- ID 回退报 `WATCH_RESET`；一页 100 封全为新邮件报 `WATCH_GAP`。它不是无损消息流：后端现有 ID/offset API 无法保证并发删除、同 ID 重用或巨大流量下的无遗漏。高流量场景需要后端 cursor API。
- 列表 `--offset` 是实时分页，不是快照；只有第一页返回总数，后续页 `totalAtFirstPage=null`。API 列表本身含完整 MIME，避免频繁大页轮询。
- 默认输出易读 JSON；`--json` 为固定封套 `{schemaVersion:1,ok,command,profile,data,warnings}`。错误为 `{schemaVersion:1,ok:false,command,error}`，不含敏感输入。成功警告字段说明完整凭据权限。
- 退出码：`0` 成功；`2` 参数/本地安全检查失败；`3` 需要登录/拒绝权限；`4` 邮件不存在或等待无匹配超时；`5` 网络/协议/大小/解析/轮询完整性失败。单请求超时或未能取得基线为 `5/TIMEOUT`；已取得基线后的总等待超时统一为 `4/NO_NEW_MAIL`。

## 验证

```sh
cd worker && pnpm install --frozen-lockfile && cd ../tools/tmctl
npm ci
npm test
npm run build
npm run test:e2e
npm run test:package
npm audit
```

E2E 将真实 Worker 在本地 workerd 启动，使用一次性 D1/KV、合成邮件与鉴权，禁用出站访问。包验收检查文件白名单、空 npm 缓存下离线安装，并对安装后的可执行文件重新跑查询与真实 Worker 测试。CI 在 Linux/macOS 各自执行；没有访问生产凭据、发送外部邮件或修改生产数据。
