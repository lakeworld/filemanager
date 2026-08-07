#!/usr/bin/env bash
set -e

# 在 Linux 服务器上交叉编译 Windows 版「启禾文件管理」安装包。
# 使用前请先运行 scripts/setup-server.sh 安装依赖。
# 签名需先运行 scripts/generate-cert.sh 生成自签名证书。

export PATH="$HOME/go/bin:/usr/local/go/bin:/usr/local/bin:$PATH"

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

CERT_PASS="${CERT_PASS:-qihe-sign-2026}"
APP_VERSION=$(grep '"productVersion"' wails.json | sed -E 's/.*"productVersion": *"([^"]+)".*/\1/')

echo "==> Version: ${APP_VERSION}"

echo "==> Installing frontend dependencies..."
cd frontend
npm install
cd "$PROJECT_ROOT"

echo "==> Tidy Go modules..."
go mod tidy

echo "==> Syncing embedded license public key..."
cp license-server/license-public.pem internal/license/license-public.pem

echo "==> Rendering application icons (if logo.svg exists)..."
if [ -f "build/logo.svg" ] && command -v python3 >/dev/null; then
  python3 -m pip install --user Pillow 2>/dev/null || true
  python3 scripts/render_logo.py || true
fi

echo "==> Building Windows sidecar updater..."
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "-H windowsgui" -o internal/updater/updater_windows_amd64.exe ./cmd/updater

echo "==> Building Windows installer..."
wails build -platform windows/amd64 -nsis

EXE="build/bin/qihefilemanager.exe"
INSTALLER="build/bin/qihefilemanager-${APP_VERSION}-amd64-installer.exe"

# ── 代码签名（自签名证书）──
if [ -f "certs/code-signing.pfx" ] && command -v osslsigncode >/dev/null 2>&1; then
  echo "==> Signing executable..."
  osslsigncode sign -pkcs12 certs/code-signing.pfx -pass "$CERT_PASS" \
    -t http://timestamp.digicert.com \
    -in "$EXE" -out "${EXE}.signed"
  mv "${EXE}.signed" "$EXE"

  echo "==> Signing installer..."
  osslsigncode sign -pkcs12 certs/code-signing.pfx -pass "$CERT_PASS" \
    -t http://timestamp.digicert.com \
    -in "$INSTALLER" -out "${INSTALLER}.signed"
  mv "${INSTALLER}.signed" "$INSTALLER"
  echo "==> Code signing complete (self-signed: 启禾软件)."
else
  echo "WARN: certs/code-signing.pfx or osslsigncode not found — skipping code signing"
  echo "      Run scripts/generate-cert.sh and apt install osslsigncode first"
fi

# ── SHA256（签名后的 installer）──
CHECKSUM=""
if [ -f "$INSTALLER" ]; then
  CHECKSUM=$(sha256sum "$INSTALLER" | awk '{print $1}')
  echo "==> Installer SHA256: ${CHECKSUM}"
else
  echo "WARN: installer not found at ${INSTALLER}"
fi

# ── version.json（ERP 前端 serve 在 /version.json）──
cat > ../web/public/version.json <<EOF
{
  "version": "${APP_VERSION}",
  "download_url": "/box/downloads/qihefilemanager-amd64-installer.exe",
  "checksum": "sha256:${CHECKSUM}",
  "release_notes": ""
}
EOF

echo ""
echo "==> Build complete. Artifacts:"
ls -lh build/bin/qihefilemanager.exe "$INSTALLER" 2>/dev/null

echo ""
echo "Next steps:"
echo "  1. Copy to downloads/ (versioned + stable name):"
echo "     cp $INSTALLER downloads/qihefilemanager-${APP_VERSION}-amd64-installer.exe"
echo "     cp $INSTALLER downloads/qihefilemanager-amd64-installer.exe"
echo "     cp build/bin/qihefilemanager.exe downloads/"
echo "  2. Copy cert for user trust (optional):"
echo "     cp certs/code-signing.crt downloads/"
echo "  3. Rebuild ERP frontend (picks up new version.json):"
echo "     make -C /opt/qihe-erp/backend deploy"
