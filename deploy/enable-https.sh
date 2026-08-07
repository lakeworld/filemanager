#!/bin/bash
set -e

# Switch from the temporary HTTP subdomain config to HTTPS.
# Run this after both box.qihebook.cloud and license.qihebook.cloud
# DNS A records point to this server's public IP.

PROJECT_DIR=/opt/qihe-erp/qihefilemanager
PUBLIC_IP=$(curl -s ifconfig.me)

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root"
  exit 1
fi

echo "==> Checking DNS..."
for host in box.qihebook.cloud license.qihebook.cloud; do
  resolved=$(dig +short "$host" | head -n1)
  if [ "$resolved" != "$PUBLIC_IP" ]; then
    echo "ERROR: $host resolves to '$resolved', expected '$PUBLIC_IP'"
    echo "Add/update the A record and wait for propagation, then rerun."
    exit 1
  fi
  echo "  $host -> $resolved OK"
done

echo "==> Requesting SSL certificates..."
certbot certonly --standalone -d box.qihebook.cloud -d license.qihebook.cloud --agree-tos -n --keep-until-expiring

echo "==> Installing HTTPS Nginx config..."
cp "$PROJECT_DIR/deploy/nginx-box.conf" /etc/nginx/sites-available/qihe-box.conf
ln -sf /etc/nginx/sites-available/qihe-box.conf /etc/nginx/sites-enabled/qihe-box.conf

# Remove the temporary HTTP config if still present.
if [ -L /etc/nginx/sites-enabled/qihe-box-http.conf ]; then
  rm -f /etc/nginx/sites-enabled/qihe-box-http.conf
fi

echo "==> Reloading Nginx..."
nginx -t
systemctl reload nginx

echo "==> Done."
echo ""
echo "Verify:"
echo "  curl -I https://box.qihebook.cloud/"
echo "  curl -I https://license.qihebook.cloud/api/health"
