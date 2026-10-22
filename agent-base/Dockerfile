FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV VNC_PASSWORD=agent

RUN apt-get update && apt-get install -y \
    xfce4 \
    xfce4-terminal \
    xfce4-goodies \
    tightvncserver \
    novnc \
    websockify \
    xterm \
    git \
    gh \
    curl \
    wget \
    python3 \
    python3-pip \
    nodejs \
    npm \
    ca-certificates \
    x11-utils \
    software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# Real browser: amd64 gets Google Chrome; arm64 (Apple Silicon) gets Firefox ESR
# (Chrome has no arm64 Linux build, so the .deb cannot install there)
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
        apt-get update && \
        apt-get install -y /tmp/chrome.deb && \
        rm /tmp/chrome.deb; \
    else \
        add-apt-repository -y ppa:mozillateam/ppa && \
        apt-get update && \
        apt-get install -y --no-install-recommends firefox-esr; \
    fi && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /root/.vnc /root/Desktop \
    && echo "$VNC_PASSWORD" | vncpasswd -f > /root/.vnc/passwd \
    && chmod 600 /root/.vnc/passwd

COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 6080

CMD ["/start.sh"]
