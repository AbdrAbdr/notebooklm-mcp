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
PUBLIC_PORT="${PORT:-8080}"
HTTP_PORT="${NOTEBOOKLM_API_PORT:-3000}"
if [ "$HTTP_PORT" = "$PUBLIC_PORT" ]; then
    HTTP_PORT=3001
fi
NOVNC_PORT="${NOVNC_PORT:-6080}"
export PUBLIC_PORT HTTP_PORT NOVNC_PORT

echo "[Entrypoint] Public reverse proxy: ${PUBLIC_PORT}; API: ${HTTP_PORT}; noVNC: ${NOVNC_PORT}."

if [ "$ENABLE_VNC" = "true" ]; then
    echo "[Entrypoint] Starting VNC services..."
    # Execute the VNC start script as the notebooklm user. Pass env vars.
    $SU_CMD "export NOVNC_PORT=$NOVNC_PORT && source /app/scripts/start-vnc.sh"
    echo ""
    echo "[Entrypoint] VNC ready at: port ${NOVNC_PORT}/vnc.html"
    echo ""
fi

cat >/etc/nginx/nginx.conf <<EOF
worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr info;

events { worker_connections 1024; }

http {
    access_log /dev/stdout;
    server {
        listen ${PUBLIC_PORT};
        server_name _;

        location ~ ^/(vnc\.html|app/|core/|vendor/|favicon\.ico|websockify) {
            proxy_pass http://127.0.0.1:${NOVNC_PORT};
            proxy_http_version 1.1;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_set_header Host \$host;
            proxy_read_timeout 3600s;
        }

        location / {
            proxy_pass http://127.0.0.1:${HTTP_PORT};
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_read_timeout 900s;
        }
    }
}
EOF

echo "[Entrypoint] Starting Node.js HTTP server on port ${HTTP_PORT} behind nginx..."
echo ""

# Ensure X11 temp dir exists with right permissions
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
chown -R notebooklm:notebooklm /tmp/.X11-unix || true

# Clean up any stale X11 locks
rm -f /tmp/.X99-lock || true

# Railway can terminate Chromium without its normal shutdown sequence. These
# lock files are runtime-only; retaining them blocks the persisted profile on
# the next deployment even though no Chrome process is still alive.
rm -f /data/chrome_profile/SingletonLock \
      /data/chrome_profile/SingletonCookie \
      /data/chrome_profile/SingletonSocket || true
chown -R notebooklm:notebooklm /data/chrome_profile 2>/dev/null || true

# Start the API as the unprivileged user. nginx remains the public foreground process.
$SU_CMD "export HTTP_PORT=$HTTP_PORT && export PORT=$HTTP_PORT && export NODE_ENV=$NODE_ENV && export NOTEBOOKLM_DATA_DIR=/data && export PLAYWRIGHT_BROWSERS_PATH=/home/notebooklm/.cache/ms-playwright && export DISPLAY=:99 && node dist/http-wrapper.js" &

if [ "$VNC_MODE" = "true" ]; then
    echo "[Entrypoint] VNC_MODE is TRUE. Launching the interactive Google login in 10s."
    $SU_CMD "node -e \"setTimeout(() => { fetch('http://localhost:$HTTP_PORT/setup-auth', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).then(r => console.log('Auth triggered:', r.status)).catch(console.error); }, 10000);\" &"
fi

exec nginx -g 'daemon off;'
