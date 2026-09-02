# DevServer 额外磁盘隔离设计

## 背景

TokenLab OVH VPS 的根文件系统已经达到 87% 使用率。现场确认现有 DevServer 的
`80G` 约束只覆盖 `/tmp` 的 loop 文件：持久 home、workspace、Docker 镜像层、
BuildKit 缓存和容器日志仍写入系统盘，导致 `.devserver` 与 Docker 存储能够绕过
限制继续增长。

OVH 已新增一块空白 100GiB 磁盘 `/dev/sdb`。本次目标是让 DevServer 的全部持久
存储与 TokenLab 生产运行时物理分离，并把整块额外磁盘全部交给 DevServer。

## 目标与不变量

1. `/dev/sdb` 建立 GPT 分区表，创建覆盖整块 100GiB 磁盘的 Linux 分区；因此
   内核文件系统本身就是容量硬上限。
2. 分区以 ext4 挂载到 `/srv/devserver`，通过 UUID 写入 `/etc/fstab`。
3. DevServer 使用独立的 `containerd` 与 `dockerd`：镜像层、snapshot、BuildKit
   缓存、容器元数据和 `json-file` 日志都落在 `/srv/devserver`。
4. DevServer 的 home、workspace、tmp 和 Cloudflare Tunnel 配置全部落在
   `/srv/devserver/runtime`。容器不得挂载系统盘上的可写业务目录。
5. `/home/ubuntu/work` 仅作为指向 `/srv/devserver/runtime/work` 的符号链接兼容
   入口；解析后的存储源仍位于额外磁盘。额外磁盘不可用时不允许回退到根盘目录。
6. TokenLab 生产容器继续使用现有 `/run/docker.sock`、系统 `containerd` 和
   `/var/lib/docker`/`/var/lib/containerd`，不得重启或迁移生产数据层。
7. DevServer 独立运行时使用专用 socket `/run/docker-devserver.sock`。部署包装器
   必须同时验证 socket、Docker Root Dir、containerd root、bind mount 来源和磁盘
   容量，任一不一致均失败关闭。
8. DevServer 与 `devserver-cloudflared` 的日志采用有限轮转；BuildKit 自动 GC
   保留上限必须显著低于 100GiB，避免构建缓存长期吃满专用盘。
9. 主 Docker daemon 最终不得保留 DevServer/Cloudflared 容器、DevServer 镜像或
   为 DevServer 创建的本地构建缓存。
10. `devserver-maintenance.timer` 每 5 分钟执行一次，必须先验证专盘、专用 Docker
    socket 与网络隔离，再处理容器健康和可再生缓存；维护任务不可并发重入。
11. 自动清理不得触碰 Git 仓库、worktree、DevSpace/Codex 会话、SSH/GitHub/TokenLab
    凭据、Cloudflare 凭据或 Docker volume。内存治理依赖 cgroup 的 12GiB RAM、
    4GiB swap 余量和 OOM 事件观测，不使用全局 `drop_caches`。

`/etc` 下少量 systemd/运行时配置与 `/run` 下 socket、PID、进程状态属于宿主机
控制面，不是容器持久数据；它们体积固定且不承载 workspace、镜像、缓存或日志。

## 架构

```text
/dev/sda1 (TokenLab 系统盘)
  system containerd + dockerd
    TokenLab PostgreSQL / Redis / app / Caddy / 辅助服务

/dev/sdb1 (整块 100GiB ext4, /srv/devserver)
  containerd/
  docker/
  runtime/
    home/
    work/
    tmp/
    cloudflared/
```

专用 `containerd-devserver.service` 将 `root` 指向
`/srv/devserver/containerd`，专用 `docker-devserver.service` 将 `data-root`
指向 `/srv/devserver/docker` 并连接专用 containerd socket。两个 unit 都使用
`RequiresMountsFor=/srv/devserver` 和 `ConditionPathIsMountPoint=/srv/devserver`，
确保磁盘未挂载时不会在系统盘自动创建替代目录。

Docker 官方把同机多 daemon 标记为实验性，因此本实现不会让两个 daemon 共享
containerd、bridge、socket、PID、exec root 或持久目录。系统 daemon 继续使用
`docker0`；专用 daemon 使用手工创建的 `br-ds-default`（`172.30.251.0/24`）作为
默认 bridge，Compose 工作负载另用 `br-devserver`（`172.30.250.0/24`）。安装脚本
和验收必须证明 TokenLab 容器清单与健康未改变。

现场曾验证 Docker Engine 29 的第二个 daemon 使用 `bridge=none` 启动时会删除系统
daemon 正在使用的 `docker0`，导致默认 bridge 上的 Reality、Hysteria2 与订阅容器
仍显示 running，但 `2443/tcp+udp` 与 `38080/tcp` 实际不可达。因此专用 systemd
unit 启动前必须先验证系统 bridge，再创建和验证自己的默认 bridge；运行时维护与
最终隔离检查也必须覆盖这两个 bridge，不得仅依赖容器状态。

## 网络边界

专用 daemon 不使用系统 daemon 的默认 bridge。它的专用默认 bridge 不承载业务
容器；Compose 使用另一条固定子网，DevServer 与 Cloudflared 只在该网络通信。
宿主机健康探针通过 systemd loopback socket proxy 转发到固定 DevServer 地址，
不让 Docker 发布 MCP 端口到公网。

如果专用 daemon 不能在不扰动系统 Docker/UFW 规则的前提下提供容器出网，迁移
必须停止并回滚，不能通过共享系统 Docker 网络或放宽 TokenLab 防火墙来完成。

## 长期运行治理

维护任务以 `/run/lock/devserver-maintenance.lock` 防止重入。容器停止时直接启动；
只有 Docker 连续健康检查已经判定 `unhealthy` 时才重启 DevServer。公网健康连续
失败 3 次才重启 Cloudflared，单次网络抖动不触发服务切换。

磁盘清理分三层：日常只删除超过保留期且未打开的 Go 构建临时目录、`/tmp` 条目、
不完整备份片段、停止容器、悬空镜像和旧 BuildKit cache；使用率达到 70% 时回收
较旧的未使用镜像并把构建缓存收紧到 4GiB；达到 85% 时删除所有未使用镜像、把
构建缓存收紧到 1GiB，并在无活动构建进程时清理可再生包缓存；达到 92% 时写入
critical 日志供外部告警。每轮记录磁盘水位、cgroup 内存当前值/峰值/上限、swap、
PID 数和 OOM 事件。

## 迁移流程

1. 验证 `/dev/sdb` 无分区、无签名、未挂载且不被任何进程使用。
2. 创建整盘分区、ext4 文件系统、UUID fstab 和 `/srv/devserver` 挂载。
3. 安装并单独启动专用 containerd/dockerd，先运行无业务 smoke container，验证
   镜像、snapshot、日志和 BuildKit 数据全部写入额外盘。
4. 等待 DevServer 内所有 agent、测试、构建和可恢复 shell 任务自然结束。
5. 清理可再生 Go build cache 与旧 `/tmp/go-build*`；不得删除 Codex/DevSpace
   会话、Git 仓库、worktree、SSH/GitHub/TokenLab 凭据或 Cloudflare 凭据。
6. 对 home、work、tmp 和 cloudflared 做在线预复制；停止旧容器后做最终
   `rsync --delete`，再记录文件数、字节数与关键配置哈希。
7. 将当前 DevServer 与固定 Cloudflared 镜像流式导入专用 daemon，不在系统盘
   生成 tar 归档；使用专用 socket启动 Compose。
8. 验证本机 `/healthz`、公网 Tunnel、DevSpace MCP 工具、Codex 子 agent、Git、
   Chromium、可执行 tmp 和容器出网。
9. 验证稳定后移除系统 daemon 中的旧 DevServer 容器、网络、精确镜像和对应
   BuildKit 缓存，再删除旧 loop 文件与根盘数据副本。

## 回滚

在专用运行时完全验收前，系统盘旧 home、work 与 loop 数据保持不变，旧容器只
停止不删除。若专用 containerd、Docker、网络或应用 smoke 失败：

1. 停止专用 DevServer Compose。
2. 解除 `/home/ubuntu/work` 的新 bind mount。
3. 用原系统 Docker daemon 启动旧 Compose。
4. 验证原 loop `/tmp`、本机 `/healthz` 与公网 Tunnel。

只有专用运行时通过完整验收，才删除系统盘旧副本，因此失败不会依赖临时构建或
重新下载镜像恢复。

## 验收标准

- `lsblk` 显示 `/dev/sdb1` 覆盖整块 100GiB 磁盘，并挂载到 `/srv/devserver`。
- 专用 Docker `DockerRootDir` 位于 `/srv/devserver/docker`，专用 containerd
  `root` 位于 `/srv/devserver/containerd`。
- 两个 DevServer 容器的 overlay、日志、镜像和所有 RW mount 都位于
  `/srv/devserver`；系统 daemon 查询不到这两个容器。
- 向 DevServer 分区写入超过剩余容量的数据只能得到 `ENOSPC`，不会增加根盘
  DevServer 数据目录。
- `/home/ubuntu/work` 解析到额外盘目录，`findmnt -T` 的 source 为 `/dev/sdb1`。
- TokenLab 正式容器镜像、健康、网络拓扑和公开健康路由保持不变。
- 根盘使用率降到 TokenLab 监控 80% 告警阈值以下；额外盘容量单独可观测。

## 参考

- Docker 官方 `dockerd` 文档：多 daemon 必须使用不同的 bridge、exec root、
  data root、PID、socket 与配置文件，并明确说明该模式属于实验性能力。
- Docker 官方 BuildKit GC 文档：使用 `defaultKeepStorage` 或自定义 GC policy
  限制 build cache 保留量。
