FROM golang:1.26.6-bookworm AS go-toolchain

FROM rust:1.94.1-bookworm AS rust-toolchain

FROM node:26.3.0-bookworm AS build

WORKDIR /opt/devspace

RUN npm install --global pnpm@11.25.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:26.3.0-bookworm

ARG GH_VERSION=2.86.0

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/ubuntu \
    CARGO_HOME=/home/ubuntu/.cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:/usr/local/go/bin:/home/ubuntu/.local/bin:/home/ubuntu/.npm-global/current/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      build-essential \
      ca-certificates \
      chromium \
      curl \
      file \
      dnsutils \
      fd-find \
      fonts-noto-cjk \
      git \
      git-lfs \
      gnupg \
      iputils-ping \
      jq \
      less \
      libffi-dev \
      libpq-dev \
      libssl-dev \
      lsof \
      make \
      netcat-openbsd \
      openssh-client \
      pkg-config \
      procps \
      python3 \
      python3-dev \
      python3-pip \
      python3-venv \
      ripgrep \
      rsync \
      shellcheck \
      sqlite3 \
      tini \
      tmux \
      tree \
      unzip \
      xz-utils \
      zip \
      vim-tiny \
      zsh \
    && chmod u+s /usr/bin/bwrap \
    && curl -fsSL --retry 3 \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
      -o /tmp/gh_checksums.txt \
    && curl -fsSL --retry 3 \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      -o /tmp/gh.tar.gz \
    && grep " gh_${GH_VERSION}_linux_amd64.tar.gz$" /tmp/gh_checksums.txt \
      | sed 's#  gh_[^ ]*_linux_amd64.tar.gz$#  /tmp/gh.tar.gz#' \
      | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf /var/lib/apt/lists/* \
      /tmp/gh.tar.gz /tmp/gh_checksums.txt "/tmp/gh_${GH_VERSION}_linux_amd64" \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && groupmod --new-name ubuntu node \
    && usermod --login ubuntu --home /home/ubuntu --move-home node \
    && mkdir -p /home/ubuntu/work /home/ubuntu/.npm-global \
    && chown -R ubuntu:ubuntu /home/ubuntu

COPY --from=go-toolchain /usr/local/go /usr/local/go
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
COPY --from=rust-toolchain /usr/local/cargo/bin /usr/local/cargo/bin
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/package.json /opt/devspace/package.json
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/pnpm-lock.yaml /opt/devspace/pnpm-lock.yaml
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/pnpm-workspace.yaml /opt/devspace/pnpm-workspace.yaml
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/node_modules /opt/devspace/node_modules
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/dist /opt/devspace/dist
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/skills /opt/devspace/skills
COPY --chmod=0755 deploy/devserver/codex-bootstrap.sh /opt/devspace/bin/codex-bootstrap.sh
RUN ln -s /opt/devspace/dist/cli.js /usr/local/bin/devspace

ARG DEVSERVER_VCS_REF=unknown

LABEL org.opencontainers.image.source="https://github.com/Ciward/devspace" \
      org.opencontainers.image.revision="${DEVSERVER_VCS_REF}" \
      org.opencontainers.image.title="DevServer" \
      org.opencontainers.image.description="Web-orchestrated DevSpace Docker development environment"

RUN npm install --global @openai/codex@0.149.1 pnpm@11.25.0 yarn@1.22.22

WORKDIR /home/ubuntu/work
USER ubuntu

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/devspace/bin/codex-bootstrap.sh", "node", "/opt/devspace/dist/cli.js", "serve"]
