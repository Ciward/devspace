# DevServer 额外磁盘隔离实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DevServer 的容器运行时、镜像、构建缓存、日志、home、workspace 与 tmp 全部迁移到独立 100GiB 额外磁盘，并从 TokenLab 系统 Docker/根盘彻底移除。

**Architecture:** 在 `/dev/sdb` 上创建覆盖整块 100GiB 磁盘的 ext4 分区并挂载到 `/srv/devserver`。独立 `containerd-devserver.service` 与 `docker-devserver.service` 使用专用 root、state、socket 和 `br-ds-default` 默认 bridge；Compose 的所有可写 mount 与 `br-devserver` 工作负载 bridge 均归属该运行时，安装和操作脚本在每次变更前验证物理挂载、系统 `docker0` 与路径边界。

**Tech Stack:** Bash、Docker Engine 29、containerd 2、Docker Compose、systemd、ext4、nftables、Node.js deployment contract tests

---

### Task 1: 锁定部署隔离契约

**Files:**
- Modify: `src/devserver-deployment.test.ts`
- Test: `src/devserver-deployment.test.ts`

- [ ] **Step 1: 写入失败契约测试**

测试应读取新的运行时配置、systemd unit、安装脚本和 Compose，并断言：

```ts
assert.doesNotMatch(compose, /DEVSERVER_HOME|DEVSERVER_WORK_ROOT|DEVSERVER_TMP_ROOT/);
for (const path of ["home", "work", "tmp", "cloudflared"]) {
  assert.ok(compose.includes(`/srv/devserver/runtime/${path}`));
}
assert.match(compose, /com\.docker\.network\.bridge\.name:\s*br-devserver/);
assert.match(compose, /subnet:\s*172\.30\.250\.0\/24/);
assert.match(compose, /max-size:\s*"64m"/);
assert.match(compose, /max-file:\s*"2"/);
assert.match(containerdConfig, /root = "\/srv\/devserver\/containerd"/);
assert.match(dockerConfig, /"data-root": "\/srv\/devserver\/docker"/);
assert.match(dockerConfig, /"iptables": false/);
assert.match(composeWrapper, /unix:\/\/\/run\/docker-devserver\.sock/);
assert.match(installScript, /findmnt/);
assert.match(installScript, /\/srv\/devserver/);
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm exec tsx src/devserver-deployment.test.ts`

Expected: FAIL，因为隔离运行时文件尚不存在，旧 Compose 仍挂载根盘路径。

### Task 2: 增加独立 containerd/Docker 运行时

**Files:**
- Create: `deploy/devserver/runtime/containerd.toml`
- Create: `deploy/devserver/runtime/daemon.json`
- Create: `deploy/devserver/systemd/containerd-devserver.service`
- Create: `deploy/devserver/systemd/docker-devserver.service`
- Create: `deploy/devserver/install-isolated-runtime.sh`

- [ ] **Step 1: 增加专用 containerd 配置**

```toml
version = 3
root = "/srv/devserver/containerd"
state = "/run/containerd-devserver"

[grpc]
  address = "/run/containerd-devserver/containerd.sock"
```

- [ ] **Step 2: 增加专用 Docker 配置**

配置必须把 data root 指向额外盘，连接专用 containerd，使用与系统 `docker0`
不同的手工 bridge，禁用自动 iptables 管理，并限制日志与 BuildKit cache：

```json
{
  "data-root": "/srv/devserver/docker",
  "exec-root": "/run/docker-devserver",
  "pidfile": "/run/docker-devserver.pid",
  "hosts": ["unix:///run/docker-devserver.sock"],
  "bridge": "br-ds-default",
  "iptables": false,
  "ip6tables": false,
  "ip-forward": false,
  "ip-masq": false,
  "log-driver": "json-file",
  "log-opts": {"max-size": "64m", "max-file": "2"},
  "builder": {"gc": {"enabled": true, "defaultKeepStorage": "8GB"}}
}
```

专用 systemd unit 的 `ExecStart` 额外传入
`--containerd=/run/containerd-devserver/containerd.sock --group=docker`。

- [ ] **Step 3: 增加失败关闭的 systemd unit**

两个 unit 均包含：

```ini
RequiresMountsFor=/srv/devserver
ConditionPathIsMountPoint=/srv/devserver
```

Docker unit 必须依赖 `containerd-devserver.service`，不得依赖或重启系统
`containerd.service`/`docker.service`。

- [ ] **Step 4: 增加安装脚本**

安装脚本只接受已经挂载的 `/srv/devserver`，并验证：

```bash
mountpoint -q /srv/devserver
[[ "$(findmnt -rn -T /srv/devserver -o SOURCE)" == /dev/sdb1 ]]
[[ "$(findmnt -rn -T /srv/devserver -o FSTYPE)" == ext4 ]]
```

脚本创建专用目录、复制配置和 unit、运行 `containerd config`/`dockerd --validate`
可用的静态检查、`systemctl daemon-reload`，但不操作系统 Docker daemon。

### Task 3: 收紧 Compose 与操作入口

**Files:**
- Modify: `deploy/devserver/compose.yaml`
- Create: `deploy/devserver/devserver-compose.sh`
- Create: `deploy/devserver/devserver-storage-verify.sh`
- Delete: `deploy/devserver/prepare-tmp-storage.sh`

- [ ] **Step 1: 让全部可写 bind mount 落入额外盘**

```yaml
volumes:
  - /srv/devserver/runtime/home:/home/ubuntu
  - /srv/devserver/runtime/work:/home/ubuntu/work
  - /srv/devserver/runtime/tmp:/tmp
```

Cloudflared 配置改为：

```yaml
volumes:
  - /srv/devserver/runtime/cloudflared:/etc/cloudflared:ro
```

删除可绕过单一根目录的 `DEVSERVER_*_ROOT` 覆盖，并为两个服务加入相同的
`json-file` 轮转上限。

- [ ] **Step 2: 固定专用 bridge**

```yaml
networks:
  edge:
    name: devserver-edge
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: br-devserver
    ipam:
      config:
        - subnet: 172.30.250.0/24
```

- [ ] **Step 3: 增加专用 Compose 包装器**

包装器固定：

```bash
export DOCKER_HOST=unix:///run/docker-devserver.sock
```

并在调用 Compose 前验证 `docker info` 的 `DockerRootDir` 精确为
`/srv/devserver/docker`、`/srv/devserver` 为 `/dev/sdb1` 的 mountpoint。

- [ ] **Step 4: 增加存储归属验证脚本**

脚本检查：专用 containerd/Docker root、Compose mount source、container log path、
overlay lower/upper path、额外盘来自完整 100GiB 专用设备，以及系统 daemon 不存在
`devserver`/`devserver-cloudflared`。

- [ ] **Step 5: 运行契约测试并确认 GREEN**

Run: `pnpm exec tsx src/devserver-deployment.test.ts`

Expected: PASS。

### Task 4: 更新运维文档

**Files:**
- Modify: `deploy/devserver/README.md`

- [ ] **Step 1: 替换旧 loop `/tmp` 说明**

文档必须说明 100GiB 额外盘是 DevServer 总存储边界，不再是单独 `/tmp` 容量；列出
专用 socket、systemd unit、数据目录、迁移命令、容量检查与故障回滚。

- [ ] **Step 2: 检查文档与实现一致**

Run:

```bash
rg -n "tmp80|prepare-tmp-storage|DEVSERVER_(HOME|WORK_ROOT|TMP_ROOT)" \
  deploy/devserver src/devserver-deployment.test.ts
```

Expected: 没有遗留旧存储入口。

### Task 5: 本地验证并提交

**Files:**
- All files from Tasks 1-4

- [ ] **Step 1: 运行定向测试**

Run: `pnpm exec tsx src/devserver-deployment.test.ts`

Expected: PASS。

- [ ] **Step 2: 运行完整测试、类型检查和构建**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
shellcheck deploy/devserver/*.sh
```

Expected: 全部 PASS，无新增 warning/error。

- [ ] **Step 3: 检查差异并提交**

```bash
git diff --check
git status --short
git add deploy/devserver src/devserver-deployment.test.ts \
  docs/superpowers/plans/2026-09-02-devserver-extra-disk-isolation.md
git commit -m "fix: isolate DevServer storage / 隔离 DevServer 存储"
```

只提交本任务文件，不加入现有 `.DS_Store` 或其它用户改动。

### Task 6: 创建并挂载整块 100GiB 分区

**Files:**
- Remote: `/dev/sdb`, `/dev/sdb1`, `/etc/fstab`, `/srv/devserver`

- [ ] **Step 1: 再次验证目标盘为空**

Run:

```bash
lsblk -e7 -o NAME,PATH,SIZE,TYPE,FSTYPE,UUID,MOUNTPOINTS,SERIAL
sudo wipefs -n /dev/sdb
sudo fuser -v /dev/sdb
```

Expected: `/dev/sdb` 精确 100GiB、无签名、无分区、未挂载、无使用者。

- [ ] **Step 2: 创建覆盖整盘的 GPT 分区并格式化**

创建从 1MiB 开始覆盖到磁盘末尾的分区，运行
`mkfs.ext4 -L devserver-storage /dev/sdb1`，并记录 UUID。

- [ ] **Step 3: 挂载并验证硬上限**

将 UUID 条目写入 `/etc/fstab`，挂载到 `/srv/devserver`。验证 `blockdev`、`df -B1`
与 `findmnt`，分区必须覆盖整块 100GiB 设备。

### Task 7: 安装并 smoke 独立运行时

**Files:**
- Remote: `/etc/devserver-runtime/*`, `/etc/systemd/system/*-devserver.service`

- [ ] **Step 1: 同步已提交的部署文件**

将远端 `/home/ubuntu/work/devspace` 更新到精确提交，先核对本地和远端 commit，
不覆盖远端未提交改动。

- [ ] **Step 2: 安装专用运行时**

运行 `sudo deploy/devserver/install-isolated-runtime.sh`，启动
`containerd-devserver.service` 与 `docker-devserver.service`。

- [ ] **Step 3: 验证空运行时归属**

使用 `DOCKER_HOST=unix:///run/docker-devserver.sock docker info`，确认 Docker root、
containerd root、socket、PID、bridge 和写入路径全部隔离；系统 Docker 容器和
TokenLab health 必须不变。

- [ ] **Step 4: 运行 disposable smoke container**

在专用 daemon 拉取固定小镜像，运行网络与写入 smoke，检查新增文件只出现在
`/srv/devserver/containerd` 与 `/srv/devserver/docker`，随后精确删除 smoke 对象。

### Task 8: 迁移数据与容器

**Files:**
- Remote: `/srv/devserver/runtime/*`

- [ ] **Step 1: 等待 DevServer 空闲**

确认没有 Codex turn、`go test`、Vitest、构建、可恢复 shell session 或最近持续写入
的 session 文件。正在运行的任务必须自然结束，不发送中断信号。

- [ ] **Step 2: 清理可再生缓存**

通过 DevServer 内部工具清理 Go build cache，并只删除已确认无进程引用的
`/tmp/go-build*` 与旧专用 gocache。记录清理前后字节数。

- [ ] **Step 3: 在线预复制**

`rsync -aHAX --numeric-ids` 复制 home、work、tmp、cloudflared 到
`/srv/devserver/runtime`；不得输出凭据内容。

- [ ] **Step 4: 停旧容器并最终同步**

停止系统 daemon 的 DevServer Compose，做最终 `rsync --delete`，验证文件数、
字节数和关键非秘密配置哈希。

- [ ] **Step 5: 流式导入镜像**

使用系统 Docker `save` 通过管道交给专用 Docker `load`，不生成根盘 tar 文件。
确认镜像 ID 与导入前一致。

- [ ] **Step 6: 使用专用 daemon 启动**

运行 `deploy/devserver/devserver-compose.sh up -d`，验证容器健康、固定 bridge、
Cloudflared Tunnel、本机 `/healthz` 和公网 MCP。

### Task 9: 切换后清理与最终验证

**Files:**
- Remote: old root-disk DevServer data and main Docker objects

- [ ] **Step 1: 完成功能 smoke**

验证 DevSpace 工具列表、读写 workspace、可恢复 Bash、Codex 子 agent、Git、SSH、
Chromium、Go/Node 构建和 `/tmp` 可执行性。

- [ ] **Step 2: 移除系统 daemon 中的旧对象**

通过旧 Compose `down` 精确删除旧容器与旧 network；按 image ID 删除 DevServer 与
不再使用的 Cloudflared 镜像。不得执行 system/image/volume prune。

- [ ] **Step 3: 删除根盘旧副本**

解除旧 loop mount 与 fstab 条目，删除已核对迁移完成的旧 loop image、旧 home
和旧 workspace 数据。删除前再次证明专用容器正在使用额外盘路径。

- [ ] **Step 4: 验证隔离与容量**

运行 `devserver-storage-verify.sh`，并记录：根盘/额外盘 `df`、两个 Docker daemon
清单、containerd roots、container log paths、overlay paths、bind mounts、systemd
状态和额外盘硬容量。

- [ ] **Step 5: 验证 TokenLab 未受影响**

检查 `sub2api-next`、PostgreSQL、Redis、Caddy 和辅助服务健康；验证
`127.0.0.1:18080/health`、正式公网 health、容器 restart/OOM 和近期 fatal/panic。
等待至少两轮 `tokenlab-monitor.timer`，确认根盘低于 80% 且状态恢复为 OK。
