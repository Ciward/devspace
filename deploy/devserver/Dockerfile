FROM golang:1.26.6-bookworm AS go-toolchain

FROM node:26.3.0-bookworm AS build

WORKDIR /opt/devspace

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26.3.0-bookworm

ARG DEVSERVER_VCS_REF=unknown

LABEL org.opencontainers.image.source="https://github.com/Ciward/devspace" \
      org.opencontainers.image.revision="${DEVSERVER_VCS_REF}" \
      org.opencontainers.image.title="DevServer" \
      org.opencontainers.image.description="Web-only DevSpace Docker development environment"

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/ubuntu \
    PATH=/usr/local/go/bin:/home/ubuntu/.local/bin:/home/ubuntu/.npm-global/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      build-essential \
      ca-certificates \
      curl \
      dnsutils \
      fd-find \
      git \
      git-lfs \
      iputils-ping \
      jq \
      less \
      lsof \
      make \
      netcat-openbsd \
      openssh-client \
      pkg-config \
      procps \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      rsync \
      sqlite3 \
      tini \
      unzip \
      xz-utils \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && groupmod --new-name ubuntu node \
    && usermod --login ubuntu --home /home/ubuntu --move-home node \
    && mkdir -p /home/ubuntu/work /home/ubuntu/.npm-global \
    && chown -R ubuntu:ubuntu /home/ubuntu

COPY --from=go-toolchain /usr/local/go /usr/local/go
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/package.json /opt/devspace/package.json
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/package-lock.json /opt/devspace/package-lock.json
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/node_modules /opt/devspace/node_modules
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/dist /opt/devspace/dist
COPY --from=build --chown=ubuntu:ubuntu /opt/devspace/skills /opt/devspace/skills

WORKDIR /home/ubuntu/work
USER ubuntu

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/devspace/dist/cli.js", "serve"]
