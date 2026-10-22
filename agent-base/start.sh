#!/bin/bash
set -e

vncserver :1 -geometry 1280x800 -depth 24
websockify --web=/usr/share/novnc 6080 localhost:5901 &

echo "noVNC ready at http://localhost:6080"
echo "VNC Password: $VNC_PASSWORD"

tail -f /dev/null
