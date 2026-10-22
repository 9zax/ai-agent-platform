#!/bin/bash
set -e

# TightVNC's vncserver wrapper requires these
export USER="${USER:-root}"
export HOME="${HOME:-/root}"

# XFCE session for TightVNC (without this the desktop is a grey twm screen)
cat > /root/.vnc/xstartup <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
xrdb "$HOME/.Xresources" 2>/dev/null || true
exec startxfce4
EOF
chmod +x /root/.vnc/xstartup

# Browser desktop shortcut (Google Chrome on amd64, Chromium on arm64 —
# both are linked as /usr/local/bin/chromium in the Dockerfile)
if command -v chromium >/dev/null 2>&1; then
    if command -v google-chrome >/dev/null 2>&1; then
        BROWSER_NAME="Google Chrome"; BROWSER_ICON="google-chrome"
    else
        BROWSER_NAME="Chromium"; BROWSER_ICON="web-browser"
    fi
    cat > /root/Desktop/web-browser.desktop <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=$BROWSER_NAME
Exec=chromium --no-sandbox --disable-gpu --no-first-run
Icon=$BROWSER_ICON
StartupNotify=true
EOF
fi

cat > /root/Desktop/terminal.desktop <<'EOF'
[Desktop Entry]
Version=1.0
Type=Application
Name=Terminal
Exec=xfce4-terminal
Icon=utilities-terminal
StartupNotify=true
EOF
chmod +x /root/Desktop/*.desktop

# One secret everywhere: when ADMIN_PASSWORD (from .env) is set, the VNC server uses it.
# The web UI auto-authenticates logged-in users with the same secret — no second prompt.
if [ -n "$ADMIN_PASSWORD" ]; then
    printf '%s\n' "$ADMIN_PASSWORD" | vncpasswd -f > /root/.vnc/passwd
    chmod 600 /root/.vnc/passwd
    vncserver :1 -geometry 1280x800 -depth 24 -localhost
else
    # No password configured — run Xvnc directly without -rfbauth (authless)
    rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null
    Xvnc :1 -geometry 1280x800 -depth 24 -localhost -rfbport 5901 &
    sleep 2
    DISPLAY=:1 startxfce4 &
fi
websockify --web=/usr/share/novnc 6080 localhost:5901 &

echo "noVNC ready at http://localhost:6080"
tail -f /dev/null
