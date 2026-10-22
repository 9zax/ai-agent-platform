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

# Browser desktop shortcut (Chrome on amd64, Firefox ESR on arm64)
if command -v google-chrome >/dev/null 2>&1; then
    cat > /root/Desktop/web-browser.desktop <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Google Chrome
Exec=google-chrome --no-sandbox --disable-gpu --no-first-run
Icon=google-chrome
StartupNotify=true
EOF
else
    cat > /root/Desktop/web-browser.desktop <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Firefox
Exec=env MOZ_ALLOW_RUN_AS_ROOT=1 firefox-esr
Icon=firefox-esr
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

# Access is gated by the platform's web login — run Xvnc directly with NO -rfbauth
# (the vncserver wrapper insists on a password; Xvnc itself starts authless without it)
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null
Xvnc :1 -geometry 1280x800 -depth 24 -localhost -rfbport 5901 &
sleep 2
DISPLAY=:1 startxfce4 &
websockify --web=/usr/share/novnc 6080 localhost:5901 &

echo "noVNC ready at http://localhost:6080 (gated by platform login)"
tail -f /dev/null
