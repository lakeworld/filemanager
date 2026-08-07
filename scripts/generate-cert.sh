#!/usr/bin/env bash
set -e

# 生成自签名代码签名证书（用于 Windows exe + installer 签名）
#
# 产物（certs/ 目录，已加入 .gitignore）：
#   code-signing.key  RSA 私钥
#   code-signing.crt  自签名证书（需随客户端分发给用户安装）
#   code-signing.pfx  PKCS#12 打包（osslsigncode 使用）
#
# 注意：自签名证书不能完全消除 Windows SmartScreen 警告。
#   - exe 属性会显示"启禾软件"而非"未知发布者"
#   - 用户把 code-signing.crt 安装到「受信任的根证书颁发机构」后本地不再警告
#   - 彻底消除 SmartScreen 需购买商业 EV 代码签名证书

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$PROJECT_ROOT/certs"
CERT_PASS="${CERT_PASS:-qihe-sign-2026}"

mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/code-signing.pfx" ]; then
  echo "证书已存在：$CERT_DIR/code-signing.pfx"
  echo "如需重新生成，请先删除 certs/ 目录"
  exit 0
fi

echo "==> 生成自签名代码签名证书（RSA 4096, 10 年有效期）..."

openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes -utf8 \
  -keyout "$CERT_DIR/code-signing.key" \
  -out "$CERT_DIR/code-signing.crt" \
  -subj "/CN=启禾软件/O=启禾软件/C=CN" \
  -addext "extendedKeyUsage=codeSigning" \
  -addext "keyUsage=digitalSignature,keyCertSign"

echo "==> 转换为 PKCS#12..."
openssl pkcs12 -export \
  -in "$CERT_DIR/code-signing.crt" \
  -inkey "$CERT_DIR/code-signing.key" \
  -out "$CERT_DIR/code-signing.pfx" \
  -passout "pass:$CERT_PASS"

# 私钥仅本地使用，移除读权限
chmod 600 "$CERT_DIR/code-signing.key"

echo ""
echo "==> 完成。产物："
echo "  证书（公开）：$CERT_DIR/code-signing.crt"
echo "  PFX（签名）：$CERT_DIR/code-signing.pfx"
echo ""
echo "下一步："
echo "  1. 签名构建：./scripts/build-server.sh（自动使用 PFX 签名）"
echo "  2. 分发证书：将 code-signing.crt 随安装包提供给用户"
echo "     用户双击 → 安装证书 → 本地计算机 → 受信任的根证书颁发机构 → 完成"
