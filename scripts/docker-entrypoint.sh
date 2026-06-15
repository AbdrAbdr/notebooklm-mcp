#!/bin/bash
# Docker entrypoint for NotebookLM MCP Server

set -e

echo "==========================================="
echo "  NotebookLM MCP Server - Docker"
echo "==========================================="
echo ""

# FIX: Railway mounts the volume as root. We must chown it to notebooklm.
if [ -d "/data" ]; then
    echo "[Entrypoint] Fixing permissions on /data volume..."
    chown -R notebooklm:notebooklm /data
    chmod -R 755 /data
fi

# Switch to the correct user for the rest of the script using su
export SU_CMD="su -s /bin/bash notebooklm -c"

ENABLE_VNC="${ENABLE_VNC:-true}"

if [ "$VNC_MODE" = "true" ]; then
    echo "[Entrypoint] VNC_MODE is TRUE. Routing public traffic to VNC."
    export NOVNC_PORT=$PORT
    export HTTP_PORT=3000
    export PORT=3000

    echo "[Entrypoint] Will automatically launch browser in 10s..."
    $SU_CMD "node -e \"setTimeout(() => { fetch('http://localhost:3000/setup-auth', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).then(r => console.log('Auth triggered:', r.status)).catch(console.error); }, 10000);\" &"
else
    echo "[Entrypoint] VNC_MODE is FALSE. Routing public traffic to HTTP API."
    export HTTP_PORT=$PORT
    export NOVNC_PORT=6080
    export PORT=$HTTP_PORT
fi

if [ "$ENABLE_VNC" = "true" ]; then
    echo "[Entrypoint] Starting VNC services..."
    # Execute the VNC start script as the notebooklm user. Pass env vars.
    $SU_CMD "export NOVNC_PORT=$NOVNC_PORT && source /app/scripts/start-vnc.sh"
    echo ""
    echo "[Entrypoint] VNC ready at: port ${NOVNC_PORT}/vnc.html"
    echo ""
fi

echo "[Entrypoint] Starting Node.js HTTP server on port ${HTTP_PORT}..."
echo ""

# Ensure X11 temp dir exists with right permissions
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
chown -R notebooklm:notebooklm /tmp/.X11-unix || true

# Clean up any stale X11 locks
rm -f /tmp/.X99-lock || true

# Start the Node.js server (foreground) dropping root privileges
exec su -s /bin/bash notebooklm -c "export HTTP_PORT=$HTTP_PORT && export PORT=$PORT && export NODE_ENV=$NODE_ENV && export NOTEBOOKLM_DATA_DIR=/data && export PLAYWRIGHT_BROWSERS_PATH=/home/notebooklm/.cache/ms-playwright && export DISPLAY=:99 && node dist/http-wrapper.js"
