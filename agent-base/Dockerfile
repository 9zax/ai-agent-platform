FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV VNC_PASSWORD=agent

# Minimal XFCE core (no metapackage/goodies extras) + VNC stack + agent tools.
# --no-install-recommends everywhere keeps the image small; fonts cover Latin + Thai.
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus-x11 \
    xfce4-session \
    xfwm4 \
    xfce4-panel \
    xfce4-settings \
    xfdesktop4 \
    xfce4-terminal \
    adwaita-icon-theme \
    fonts-dejavu-core \
    fonts-thai-tlwg \
    tightvncserver \
    novnc \
    websockify \
    git \
    curl \
    wget \
    jq \
    zip \
    unzip \
    ripgrep \
    rsync \
    openssh-client \
    file \
    tree \
    less \
    nano \
    xz-utils \
    python3 \
    python3-pip \
    ca-certificates \
    x11-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22 for agents (Ubuntu 22.04's apt nodejs is v12; npm is bundled)
RUN case "$(dpkg --print-architecture)" in \
        arm64) NARCH=arm64 ;; \
        *) NARCH=x64 ;; \
    esac && \
    curl -fsSL "https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-${NARCH}.tar.gz" \
        | tar -xz -C /usr/local --strip-components=1 \
    && node -v && npm -v

# Docker CLI + compose v2 plugin — agents talk to the HOST daemon via the
# mounted /var/run/docker.sock (the deploy stage runs `docker compose up` for
# real). Static binaries; dpkg arch maps to Docker's static arch names.
RUN case "$(dpkg --print-architecture)" in \
        arm64) DARCH=aarch64 ;; \
        *) DARCH=x86_64 ;; \
    esac && \
    curl -fsSL "https://download.docker.com/linux/static/stable/${DARCH}/docker-27.5.1.tgz" \
        | tar -xz -C /tmp && mv /tmp/docker/docker /usr/local/bin/docker && rm -rf /tmp/docker && \
    mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v2.34.0/docker-compose-linux-${DARCH}" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose && \
    docker --version && docker compose version

# Real browser, exposed uniformly as /usr/local/bin/chromium:
# - amd64 gets Google Chrome (official .deb)
# - arm64 (Apple Silicon) gets Chromium via Playwright — Google ships no arm64
#   Linux Chrome, and Ubuntu's chromium-browser package is a snap stub that
#   cannot run in Docker.
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
        apt-get update && \
        apt-get install -y --no-install-recommends /tmp/chrome.deb && \
        rm /tmp/chrome.deb && \
        ln -sf /usr/bin/google-chrome /usr/local/bin/chromium; \
    else \
        npx --yes playwright@latest install --with-deps --no-shell chromium && \
        ln -sf /root/.cache/ms-playwright/chromium-*/chrome-linux*/chrome /usr/local/bin/chromium && \
        rm -rf /root/.npm; \
    fi && rm -rf /var/lib/apt/lists/* && chromium --version

# Xvnc dies without the classic bitmap font 'fixed' (xfonts-base) — previously
# pulled in via apt recommends. Kept as its own late layer so edits to the apt
# list above never invalidate the big browser layer in the build cache.
RUN apt-get update && apt-get install -y --no-install-recommends xfonts-base \
    && rm -rf /var/lib/apt/lists/*

# gh CLI from GitHub's official repo. Ubuntu 22.04's apt build (2.4.0, 2022)
# is too old for `gh auth git-credential`, so the GitHub connector's
# `gh auth setup-git` leaves git unable to authenticate — install latest.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* && gh --version

RUN mkdir -p /root/.vnc /root/Desktop \
    && echo "$VNC_PASSWORD" | vncpasswd -f > /root/.vnc/passwd \
    && chmod 600 /root/.vnc/passwd

COPY --chmod=755 start.sh /start.sh

EXPOSE 6080

CMD ["/start.sh"]
