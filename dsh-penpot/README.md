# dsh-penpot

在 DSH 里管理本机 Penpot，并让 AI 通过官方 MCP 做**可编辑**的海报、社媒封面和简单矢量稿。

- 左侧栏「设计」只是管理页：启动/停止/重启 Penpot、看日志、复制 Penpot 地址；不再嵌入画布。
- Penpot 跑在本机 Docker，独立监听 **3300**（容器内 8080），不经过 DSH 的 `/penpot` 代理和 DSH 登录 Cookie。
- 用户直接用浏览器打开 `http://<主机>:3300/`，用 Penpot 自己的账号登录；插件只负责起服务和给 AI 用 MCP。
- 官方 Penpot MCP 已接通：AI 可以用 `mcp__penpot__execute_code` 生成原生文字、形状、渐变图层；用导出的图片/PDF 做交付。
- 自带 `penpot-poster` 技能，教 AI 按尺寸、版式和印刷边界生成，而不是贴一张死图。

## 安装

插件不依赖本机固定路径，可以装到任意 DSH profile：Linux 服务器、macOS/Windows 的 DSH 桌面端都可以。要求：

- DSH `>= 0.2.2-rc.1`（`package.json` 已声明）。
- Docker Engine 24+ 与 Docker Compose v2；Windows/macOS 用 Docker Desktop（Linux containers）。
- 宿主机 `3300`（Penpot 页面）和 `127.0.0.1:4401`（MCP）可用；3300 需要放行给用户访问。

### DSH Web / 其他服务器

```bash
dsh plugin --profile web add /opt/dsh-plugins/dsh-penpot
```

确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里有 `dsh-penpot`，然后重启 `dsh web`。

### DSH 桌面端（PC）

1. 先把本仓库打包成 `dsh-penpot-0.1.0.tgz`（见「开发/测试」），或直接使用整个插件目录。
2. 打开 DSH 桌面端 → **设置 → 插件 → 本地安装 / 从文件安装**，选择 tgz 或插件目录。
3. 启用 `dsh-penpot`，然后**完全退出并重开** DSH 桌面端。
4. 在桌面端左侧栏点「设计」，点「启动 Penpot」。首次会拉镜像，1–3 分钟。

> 桌面端的 `desktop` profile 由 Electron 独占管理；不要同时用命令行 `dsh --profile desktop` 启动同一个 profile，避免锁冲突。

### 数据目录（可移植）

新安装默认用 `~/.dsh/penpot`（macOS/Windows/Linux 都一样），不需要 root，也不写死 `/opt`。可以用环境变量覆盖：

```bash
DSH_PENPOT_DIR=/your/writable/dir
```

Linux 上如果已经存在 `/opt/penpot/docker-compose.yml`，且 `~/.dsh/penpot` 还不存在，插件会继续使用旧的 `/opt/penpot`，避免升级后找不到原数据。迁移旧数据时，把整个目录复制到新位置，再设 `DSH_PENPOT_DIR` 即可。

Windows 路径同样支持（如 `DSH_PENPOT_DIR=C:\Users\你\.dsh\penpot`）；Compose 的素材挂载会自动转成正斜杠。Docker Desktop 需要允许共享该目录（Settings → Resources → File sharing）。

## 第一次使用

1. 打开 DSH Web，点左侧栏的「设计」。
2. 点「启动 Penpot」。首次启动会拉镜像/初始化数据库，约 1–3 分钟；状态变「可用」。
3. 点面板里的「打开 Penpot」，或直接在浏览器打开 `http://<主机>:3300/`。
4. 注册/登录 Penpot 账号（这是 Penpot 自己的登录，不是 DSH 登录）。
5. 新建或打开一个设计文件。首次使用先在账号 **Settings → Integrations → MCP Server** 启用并生成 MCP Key。
6. 打开设计文件后，MCP 插件会自动连接（工具栏出现绿点 MCP），保持这个标签页可见；没有绿点就刷新一次文件页。
7. 回到 DSH 会话，用中文描述海报，例如：
   > 做一张 1080×1440 的夏日促销海报，深色背景、橙色主色块、超大“夏日特惠”、价格 ¥99、底部活动时间；文字和色块都要可编辑。

## 访问地址

| 访问方式 | 地址 | 说明 |
|---|---|---|
| 本机 | `http://127.0.0.1:3300/` | 服务器本机浏览器/调试用 |
| 公网/局域网 | `http://<主机名或 IP>:3300/` | 需要防火墙/安全组放行 TCP 3300 |
| DSH 面板 | `http://<主机>:3300/` | 面板只显示这个地址，不再用 iframe |

Penpot 前端容器内是 **8080**，宿主机映射为 **3300**。端口只由 `frontendPort` 决定，不再和 DSH 的 3000/3001 混在一起。

> 桌面端如果 DSH 的公开地址不是本机（例如远程/反代），面板里的地址可能打不开；到「设置 → Penpot」把 `publicUri` 改成实际可达的 `http://127.0.0.1:3300/` 或局域网地址。

## 画布和编辑

| 产物 | 还能编辑吗 | 说明 |
|---|---|---|
| `.penpot` 源文件 | 能 | Penpot 原生文件，图层、文字、组件都在 |
| AI 生成的文字/形状/渐变 | 能 | 都是 Penpot 原生图层，不是截图 |
| SVG 导出 | 部分能 | 矢量可编辑；组件、布局、设计 token 会丢 |
| PNG/JPEG/PDF 导出 | 不能 | 平面图，不能再拆图层 |
| CorelDRAW | 通过 SVG/PDF | `.penpot` 不能被 CorelDRAW 直接打开 |

## 印刷边界（重要）

Penpot 是 **RGB** 工作流，没有原生 CMYK/专色，也没有专业印前出血/叠印/陷印设置。

- 先用 Penpot 做版式和可编辑稿，导出 **SVG/PDF**；
- 再到 CorelDRAW/Acrobat/Illustrator 转 CMYK、加 3mm 出血、检查黑色叠印、文字转曲；
- 中文字体要在 Penpot 团队设置 → Fonts 里上传（TTF/OTF/WOFF），否则可能显示方框；印刷前必须嵌入或转曲；
- 文字转曲可用 Penpot 2.x 右键 **Flatten**，但先复制一份保留可编辑版本。

## 本机结构

| 项 | 值 |
|---|---|
| Penpot 版本 | 2.18.6（不要用 2.19，含破坏性迁移） |
| 数据目录 | 新装默认 `~/.dsh/penpot`；本机旧装自动沿用 `/opt/penpot`；可用 `DSH_PENPOT_DIR` 覆盖 |
| Compose | `<数据目录>/docker-compose.yml` |
| 环境变量 | `<数据目录>/.env`（0600，含随机密钥） |
| 前端 | `0.0.0.0:3300` → 容器 `8080` |
| MCP | `127.0.0.1:4401/mcp`（只绑本机） |
| 公开地址 | `http://<DSH 域名或本机 IP>:3300/` |
| 素材收件箱 | `<数据目录>/imports`（只读挂进 MCP 容器） |

改端口：改插件目录 `cordis.patch.yml` 里的 `frontendPort`（当前 3300），再重启 DSH；插件下次启动会重写 `.env` 的 `PENPOT_PUBLIC_URI`。改公开域名也可以在「设置 → Penpot」里改 `publicUri`。

## 安全

- 前端现在绑定 `0.0.0.0:3300`，**不再经过 DSH 的登录门**；Penpot 用自己账号体系登录。
- **3300 是 HTTP，登录密码明文传输**。只建议在内网/可信网络使用；公网使用请在前面加一层 HTTPS 反向代理（Nginx/Caddy），或限制来源 IP。
- Penpot 当前开放注册且不验证邮箱（`disable-email-verification`）。公网暴露时任何人可注册；建好账号后建议加 `disable-registration` flag，或用防火墙只放行可信来源。
- MCP 仍只绑定 `127.0.0.1:4401`，不对公网开放。
- `.env` 和 `settings.json` 均为 0600；日志返回前会脱敏 `PENPOT_SECRET_KEY`、数据库密码、Authorization、`userToken`。
- 删除数据会丢设计：`docker compose ... down -v` 会删库和素材卷，执行前先导出 `.penpot`。

## 常见问题

**`http://<主机>:3300/` 打不开**
- 先看面板「日志」，确认 `dsh-penpot-penpot-frontend-1` 是 running。
- 本机 `curl -I http://127.0.0.1:3300/` 应为 200；如果本机通、公网不通，是云安全组/NAT 没放行 3300。
- 页面刚打开可能先深色 1–2 秒，等前端脚本初始化完；不要连续硬刷新。

**页面空白 / 一直转圈**
- 打开浏览器控制台看有没有 JS 报错；先硬刷新（Ctrl/Cmd+Shift+R）。
- 确认地址是 `http://<主机>:3300/`，不是旧的 `/penpot/` 子路径。
- 如果刚重启过容器，等 10–20 秒再打开；后端启动比前端慢。

**MCP 工具不出现**
- 确认已打开设计文件且标签页没休眠；插件会在打开文件后自动连接（工具栏绿点 MCP），2.18.6 没有“File → MCP Server → Connect”入口。
- `penpot_status.mcpListening` 只说明 MCP 端口在监听，不代表画布已连接；以插件工具栏绿点和 `execute_code` 返回 1 自检为准。
- 确认 `127.0.0.1:4401/mcp` 可访问；`penpot_status` 里 `mcpListening` 应为 true。
- `@deepseek-ai/dsh-mcp-client` 若未被 DSH 解析，按 DSH 文档把它装进当前 profile；`cordis.patch.yml` 里的 `penpot-mcp` 行已经配好。

**导出返回空 / `Input Bit Array is empty`**
- 2.18.6 的 MCP 导出有已知问题：先试一次 `export_shape`，失败就按 [skills/penpot-poster.md](skills/penpot-poster.md) 的 `generateMarkup` + `uploadMediaData` SVG 兜底，不要连续重试空文件。

**中文显示方框**
- 上传中文字体后在文字图层设置 `fontFamily` 为字体列表里的确切名称；或先在 Penpot 里手动改一次字体，再让 AI 继续。

**内存不够**
- 当前 compose 限制：backend 2g、exporter 768m、其余较小；4GB 以下机器不要同时跑其他重服务。

## 开发/测试

```bash
cd /opt/dsh-plugins/dsh-penpot
node --check client.js
node --test test/*.test.js
npm pack --pack-destination /opt/dsh-plugins/out
```

打包会生成 `dsh-penpot-0.1.0.tgz`，DSH 桌面端可「从文件安装」。纯函数单测覆盖配置校验、跨平台路径、Compose 渲染、密钥保留/脱敏、设置文件原子写入；Docker、Penpot 页面和 MCP 需要在实际宿主机启动后验证。**Windows/macOS 桌面端的 Docker 行为尚未在真机验证**，首次安装请按上面的端口/文件共享检查。
