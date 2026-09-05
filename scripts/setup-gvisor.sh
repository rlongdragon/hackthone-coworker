#!/usr/bin/env bash
# 安裝 gVisor (runsc) 並註冊為 Docker runtime — agent sandbox 用。
# 冪等;用 SIGHUP reload,不重啟 docker daemon(既有容器不中斷)。
set -euo pipefail

ARCH=$(uname -m)
URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"

if ! command -v runsc >/dev/null 2>&1; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/runsc" "$URL/runsc"
  curl -fsSL -o "$tmp/runsc.sha512" "$URL/runsc.sha512"
  (cd "$tmp" && sha512sum -c runsc.sha512)
  install -m 755 "$tmp/runsc" /usr/local/bin/runsc
fi
runsc --version

# daemon.json:加 runsc runtime(保留既有設定)
CONF=/etc/docker/daemon.json
if [ ! -f "$CONF" ]; then
  echo '{}' > "$CONF"
fi
python3 - "$CONF" <<'EOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c.setdefault("runtimes", {})["runsc"] = {"path": "/usr/local/bin/runsc"}
json.dump(c, open(p, "w"), indent=2)
EOF

systemctl reload docker
docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' | grep -q runsc \
  && echo "OK: runsc registered" \
  || { echo "ERROR: runsc not registered"; exit 1; }
