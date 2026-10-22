# 优选地址、订阅与 SaaS 接入

核对日期：2026-10-22。实现基于 `main` 的 `b1f01369703db9912172acc59fef089db95de8ac`，保留单文件 Worker 的使用方式。

## 这个仓库能做什么

| 文件 | 现有职责 | 本次处理 |
| --- | --- | --- |
| `SRC/index.js` | D1 管理界面、DNS 克隆、公开 IP 源采集与 GitHub 同步 | 保留原逻辑 |
| `SRC/CF-DNS-Clone-Vless-Sub.js` | 上述功能，加节点生成、订阅转换、WebSocket 转发 | 实现独立 TLS 主机名与一致的优选地址解析 |
| `SRC/snippets.js` | 独立的 VLESS/WebSocket/XHTTP 处理脚本 | 保留原逻辑，线上运行能力需单独确认 |
| 根目录 `*.txt` | 已采集的地址快照 | 保留数据，不把历史快照视为当前最优结果 |

这里的“优选”是使用来源站点或用户已经选择的结果。本次没有新增测速器，也没有在本机进行公网 IP 扫描、排名或可用性测试。

## 四种地址的职责

| 地址 | 用途 | 示例 |
| --- | --- | --- |
| 优选 IP / 优选域名 | 客户端实际连接的地址，即分享链接的 `@地址:端口` | `192.0.2.1:443` |
| 业务域名 | TLS SNI 与 WebSocket Host；证书和请求规则要覆盖这个名字 | `snippet.customer.example` |
| 转发目标 | 客户端连接本 Worker 时，由 Worker 转发 WebSocket 的上游 | `https://upstream.example.net` |
| SaaS CNAME target / fallback origin | 将业务域名接入服务商 zone，以及指定回源位置 | 用户实际配置的 SaaS 目标与源站 |

脚本里的 `ProxyIP` 用于服务端出站连接／重试，和客户端入站的优选 IP 属于不同环节。

DNS 克隆只复制记录，不能开通 SaaS、签发证书或使 Snippets 规则生效。Cloudflare 开启代理的 DNS 记录返回平台的 anycast 地址；不能通过把记录内容写成某个优选 IP，就保证客户端会拿到该地址。[官方 DNS 代理说明](https://developers.cloudflare.com/dns/proxy-status/)

## 与参考文章及当前官方文档的核对

[参考文章](https://blog.zrf.me/p/Cloudflare-Snippets-SaaS/)将“Snippets 处理请求、SaaS 接入业务域名、DNS 选择入口地址”串起来。前两者的职责可以用于理解现有架构，但文章最后把 SaaS CNAME 改到其他优选域名的做法不作为本项目自动操作。

当前官方标准接入要求业务域名指向 SaaS CNAME target；生产就绪需同时确认 hostname `status=active`、`ssl.status=active` 以及 DNS 指向正确。普通 A 记录接入需要另外具备 apex proxying。取得证书并不能证明任意第三方 CNAME 会持续正确路由。[SaaS 接入说明](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)

对于也托管在 Cloudflare 的客户域名，官方明确说明移除服务商 CNAME 会停止该服务的路由并使 hostname 进入 Moved 状态。因此，不把“证书签好后就可以永久改走其他 CNAME”当成可靠前提。[自定义主机名移除与路由状态](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/remove-custom-hostnames/)

Snippets 根据 zone 内匹配规则处理 HTTP 请求和响应，不负责 DNS 选路。按当前文档，Free 不包含 Snippets；已付费套餐的额度和 5 ms / 2 MB / 32 KB 限制也不能沿用旧文章中的固定数量或“无限”描述。[Snippets 说明与限制](https://developers.cloudflare.com/rules/snippets/)

带 D1 的管理／订阅脚本应运行在 Workers。仓库的独立 `snippets.js` 引入了 `cloudflare:sockets`；仅凭文件名与旧教程，无法确认用户当前 Snippets 运行时支持这份代码。官方功能对照把非 HTTP 协议与 D1 等平台功能列为 Workers 的能力，故本次没有宣称完成 Snippets 代理部署验证。[Snippets 与 Workers 对照](https://developers.cloudflare.com/rules/snippets/when-to-use/)

## 使用本次实现

在合并版后台“代理参数”中填写：

1. **workers 或 Snippets 地址**：已有 WebSocket 上游，供本 Worker 转发时使用。
2. **节点 TLS SNI / WebSocket Host**：已生效的业务域名，仅填完整域名，不带协议、端口、路径或 IP。国际化域名使用 Punycode。
3. **Path 与 UUID**：与实际后端要求一致。使用指定 UUID 时填写已有值；模板不包含或生成凭据。
4. **自定义节点**：填写已有优选结果，也可继续使用克隆域名、启用的 GitHub IP 源与规范化后的外部源。

例如，优选地址为 `192.0.2.1`、TLS 主机名为 `snippet.customer.example` 时，生成结果的地址为 `192.0.2.1:443`，`sni` 和 `host` 都为 `snippet.customer.example`，转发目标不会替代这个显式设置。这只控制客户端参数，不修改该业务域名的 DNS。

TLS 主机名留空时，沿用 `useProxyUrlForSni` 的旧设置：优先使用转发地址中的主机名，否则使用当前订阅请求的主机名。移除了内部节点在空配置时隐式采用第三方 `snippets.neib.cn` 的特例。

自定义地址格式：

```text
192.0.2.1#默认 443
192.0.2.2:8443#指定端口
[2001:db8::1]:443#IPv6
2001:db8::2#裸 IPv6，默认 443
preferred.example.net:2053#域名@/custom?ed=2560
```

`#名称`、`@路径` 可省略；IPv6 带端口必须加方括号。空行、`#` 或 `//` 开头的注释、无效地址与端口会被忽略。Path 输入原始值，分享链接只编码一次；不要预先把 `/` 写成 `%2F`。此行为遵循 [Xray 分享链接提案](https://github.com/XTLS/Xray-core/discussions/716)。

使用的是用户提供的入口候选地址，本地解析通过不代表它属于 Cloudflare、在用户网络上最快，或能承载该业务域名；实际 TLS、WebSocket 与端到端连通仍需按选定服务验证。

## 配置模板

- `config/preferred-ip.example.json`：字段示例；地址均为文档用途，不能实际连通，UUID 留空等待填入已有值。
- `wrangler.example.toml`：合并版入口与 `WUYA` D1 绑定；数据库 ID 为占位，路由和定时触发器为空。

JSON 是字段参考，不是自动导入程序。请在现有后台填写，或先读取已有设置后合并字段，避免用示例覆盖其他配置。线上配置文件、凭据及 Wrangler 本地状态已加入 `.gitignore`。

## 本地验证

需要 Node.js 22.13 或更高版本，无需安装依赖：

```sh
npm run check
npm test
git diff --check
```

测试执行真实单文件 Worker 的函数及 `fetch` 路由，用内存 SQLite 模拟 D1；所有未显式模拟的 HTTP／socket 调用都会抛错。覆盖四种节点来源、IPv4／IPv6、端口、中文备注、Path 单次编码、旧配置回退、设置持久化和 Base64 订阅响应。该测试不等同于 workerd／Cloudflare 线上运行验证。

## 线上仍需用户确认的选择

- 用于节点 TLS／Host 的实际业务域名，以及它由哪个 SaaS 服务商 zone 接入；仓库没有保存这个业务选择。
- 采用已有 Worker 后端还是要使用 Snippets；若用 Snippets，需要确认当前套餐与脚本所需运行能力。
- 具体上游、后端 UUID／Path、订阅转换服务，以及优选候选来源／目标网络。项目默认的外部服务不代表用户已选择它们。
- 如仍希望修改 DNS，先明确独立优选地址域名与 SaaS 业务域名的角色，防止现有 DNS 克隆任务覆盖 SaaS CNAME。

确认后才安排独立的线上步骤：检查 hostname 和证书状态、核对 SaaS CNAME 与 Snippets 主机名规则、验证 TLS／WebSocket、在用户实际网络测量候选线路，最后按另行授权决定部署、DNS 或定时同步。本地实现和验证阶段没有执行这些线上操作，也没有创建 PR 或创建凭据。
