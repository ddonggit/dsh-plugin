# dsh-restart

DSH Web 的「服务与重启」插件：在设置页里安全地重启 `dsh web`，显示阶段进度、失败现场和运行状态。

设计目标是**换一台机器也能用**：不假设服务一定叫 `dsh-web`，不假设一定有 systemd，也不假设监听在
`127.0.0.1` 或走 HTTP。

## 运行要求

- DSH `>= 0.2.1-rc.2`（宿主半 + Web 前端半）
- Node.js `>= 20`
- 常规场景：Linux（有或没有 systemd 都可以）
- 非 Linux：没有 `/proc` 时，进程/端口探测会退回 `lsof` / `ss` / `ps`；macOS 的「直接重启」属于
  尽力支持，Windows 未经验证

## 安装

### 1. 把包装进 profile

```bash
# 本地目录安装（改代码不必重装）
dsh plugin --profile web add /path/to/dsh-plugins/dsh-restart
```

`dsh plugin` 只会维护依赖，**不会自动把包加进 bundle 列表**。

### 2. 加进 profile 的 bundle 列表

编辑 `$DSH_PROFILE_DIR/package.json`（一般是 `~/.dsh/profiles/web/package.json`），把
`dsh-restart` 加到 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-restart"]
    }
  }
}
```

注意：某些插件市场/管理器在安装别的插件时会重写这个列表，装完其它插件后最好复查一次：

```bash
dsh --profile web --dump-config | grep -A3 'id: dsh-restart'
```

### 3. 重启一次 dsh web

首次安装后需要重启一次服务，插件才会进入运行中的进程：

```bash
systemctl restart dsh-web     # 单元名以你的机器为准
```

或者用你平时的启动方式重新启动。之后设置页会出现「服务与重启」。

## 它是怎么判断该用哪种重启方式的

每次启动时自动收集事实，而不是读死配置：

| 事实 | 来源 | 用途 |
|---|---|---|
| 当前进程在哪个 systemd 单元里 | `/proc/self/cgroup` | 自动得到真实单元名（任意名字，不用改代码） |
| 是不是 user 管理器 | cgroup 里的 `user@…` / `/user.slice` | 决定 `systemctl --user` / `systemd-run --user` |
| 有没有 `systemctl` / `systemd-run` | `PATH` | systemd 模式 / 直接重启模式 |
| 监听地址、端口 | `webServer.host` / `webServer.port` | 探测与状态展示 |
| 对外的公开 URL | `webApp.getAdvertisedUrl()` | 状态展示（**不用于探测**，避免 NAT 回环问题） |

### systemd 模式（默认，识别到单元时）

1. 用 `systemd-run --scope` 把执行器搬出目标单元的 cgroup（否则重启会把它一起杀掉）。
2. `systemctl restart <unit>`。
3. 等新 `MainPID`，用「TCP + HTTP(S)」探测端口，再等新实例写回启动标记。
4. 核对监听端口的 PID 就是新的 `MainPID`。

单元名是从 cgroup 读出来的，不要求叫 `dsh-web`。

### 直接重启模式（没有 systemd，或显式指定）

1. 如果进程其实在某个单元里，先 `systemctl stop` 该单元（避免 `Restart=always` 和手动启动抢端口）。
2. 停掉旧进程（只接受能被识别为 `dsh web` 的目标，否则拒绝 kill）。
3. 用宿主原来的 `argv` 重新拉起新进程（`systemd-run --scope` 可用时放进独立 scope，否则 `detached`）。
4. 等新端口 + 启动标记，再核对监听 PID。

适合：裸跑、`tmux`/`nohup`、容器、开发机、macOS。

## 端口探测

旧版本固定探测 `http://127.0.0.1:<port>/`，在「绑定具体网卡 + 自己终止 TLS」的部署上必然误判。
现在：

1. 先对 `webServer.host:webServer.port` 做 TCP 连接（回环、具体网卡、IPv4/IPv6 都行）。
2. 再尽量发一次 HTTP(S) 请求：
   - 有响应且 `< 500` → 在线；
   - 有响应但 `>= 500` → 不健康；
   - TLS/证书/超时等探测失败但 TCP 通 → **仍然算在线**，只把探测方式记为 `tcp`。
3. 对 IP 字面量上的 HTTPS 放宽证书校验（证书通常是签给域名的，用绑定 IP 探测必然不匹配）。

因此：`http://127.0.0.1:3081`、`https://10.1.0.2:3000`、`https://api.example.com:3000` 都能正确判断。

## 配置

优先用环境变量（写进 systemd 单元或启动脚本），也可以在 bundle 的 `config` 里写同名驼峰字段。

| 环境变量 | config 字段 | 取值 | 说明 |
|---|---|---|---|
| `DSH_RESTART_MODE` | `mode` | `auto` / `systemd` / `direct` | 默认 `auto` |
| `DSH_RESTART_UNIT` | `unit` | 单元名 | 默认从 cgroup 识别 |
| `DSH_RESTART_MANAGER` | `manager` | `system` / `user` | 默认从 cgroup 识别 |
| `DSH_RESTART_SYSTEMCTL` | `systemctl` | 路径 | 默认 `PATH` 里的 `systemctl` |
| `DSH_RESTART_SYSTEMD_RUN` | `systemdRun` | 路径 | 默认 `PATH` 里的 `systemd-run` |
| `DSH_RESTART_HEALTH_URL` | `healthUrl` | URL | 覆盖自动推导的探测地址 |
| `DSH_RESTART_START_CMD` | `startCommand` | JSON 数组 | 覆盖「用原 argv 重启」 |
| `DSH_RESTART_DATA_DIR` | — | 目录 | 状态/日志目录，默认 `$DSH_HOME/dsh-restart/data` |

示例（systemd 单元里）：

```ini
Environment=DSH_RESTART_MODE=auto
Environment=DSH_RESTART_UNIT=my-dsh.service
```

配置示例（bundle 的 `config`）：

```yaml
- insert:
    - id: dsh-restart
      name: dsh-restart
      config:
        mode: auto
```

## 安全约束

- **只 kill 能确认是 `dsh web` 的进程**（读 `/proc/<pid>/cmdline`；非 Linux 用 `ps`）；目标不对就报
  `DIRECT_TARGET_UNSAFE`，不冒险。
- systemd 模式必须先把执行器搬出单元 cgroup，搬不出去就失败（`NOT_ISOLATED`），不做「点完就失联」的重启。
- 兜底启动失败时，会尝试 `systemctl start` 把单元托管恢复回来。
- 重启接口有 3 秒冷却和并发保护；同一时间只允许一轮。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/dsh-restart/status` | 运行状态、最近一次/历史、执行器心跳、运行环境 |
| `POST` | `/api/dsh-restart/restart` | `{"action":"restart","requestId":"..."}` |
| `GET` | `/api/dsh-restart/log?lines=200` | 执行器日志尾部 |

`/api` 走 DSH 的浏览器信任栅栏，需要正常的浏览器会话（cookie）。

## 排障

1. **设置页没有「服务与重启」**
   - 检查 bundle 列表：`dsh --profile web --dump-config | grep -A3 'id: dsh-restart'`
   - 检查依赖链接：`ls -l "$DSH_PROFILE_DIR/node_modules/dsh-restart"`
   - 改完 profile 后需要重启 dsh web。

2. **状态里 `mode` 不对**
   - `systemd`：应显示真实单元名；不对就用 `DSH_RESTART_UNIT` 指定。
   - `direct`：没有识别到 systemd 单元，或没有 `systemctl`。
   - 看 `sys.modeReason`：`cgroup-unit` / `configured-unit` / `no-unit` / `systemctl-missing` / `explicit`。

3. **重启失败**
   - 先看页面上的错误码和「执行器日志」；
   - 数据目录：`$DSH_HOME/dsh-restart/data`，日志 `runner.log`，单轮状态 `run.json`；
   - systemd 模式：`systemctl status <unit>` / `journalctl -u <unit> -n 100`；
   - 直接模式：看 `runner.log` 里启动命令的输出和端口占用。

4. **`NOT_ISOLATED`**
   - systemd 模式找不到 `systemd-run`：装上 systemd 工具，或把 `DSH_RESTART_MODE=direct` 并确保进程不在单元里。

5. **`DIRECT_TARGET_UNSAFE`**
   - 端口上的进程不是可识别的 `dsh web`。先手动确认端口占用，再重试。

## 自测

```bash
node test/selftest.mjs
```

不碰真实服务：用假 `systemctl`、假 `dsh web`、临时端口跑纯逻辑、宿主路由、systemd 端到端、
直接重启端到端、HTTP/HTTPS/TCP 探测，以及兜底路径。
