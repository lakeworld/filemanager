#!/usr/bin/env bash
set -e

# 在 Linux 服务器（Ubuntu/Debian）上安装编译「启禾文件管理」所需的依赖。
# 运行后请重新登录或 source ~/.bashrc 使环境变量生效。

UBUNTU_VERSION=$(lsb_release -rs 2>/dev/null || echo "")

echo "==> Updating package list..."
sudo apt-get update

echo "==> Installing base tools..."
sudo apt-get install -y git curl wget build-essential nsis

# 安装 Go 1.23（若未安装或版本低于 1.23）
install_go() {
  local GO_VERSION="1.23.4"
  local GO_TAR="go${GO_VERSION}.linux-amd64.tar.gz"
  local GO_URL="https://go.dev/dl/${GO_TAR}"

  echo "==> Downloading Go ${GO_VERSION}..."
  curl -L "${GO_URL}" -o "/tmp/${GO_TAR}"
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "/tmp/${GO_TAR}"

  if ! grep -q '/usr/local/go/bin' ~/.bashrc; then
    echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
  fi
  export PATH=$PATH:/usr/local/go/bin
}

if command -v go &>/dev/null; then
  GO_CURRENT=$(go version | awk '{print $3}' | sed 's/go//')
  if [ "$(printf '%s\n' "1.23" "$GO_CURRENT" | sort -V | head -n1)" = "1.23" ]; then
    echo "==> Go ${GO_CURRENT} already installed, skipping."
  else
    echo "==> Go ${GO_CURRENT} is too old, upgrading..."
    install_go
  fi
else
  install_go
fi

# 安装 Node.js 20 LTS（若未安装）
if command -v node &>/dev/null; then
  NODE_CURRENT=$(node -v | sed 's/v//')
  if [ "$(printf '%s\n' "20" "$NODE_CURRENT" | sort -V | head -n1)" = "20" ]; then
    echo "==> Node.js ${NODE_CURRENT} already installed, skipping."
  else
    echo "==> Node.js ${NODE_CURRENT} is too old, upgrading..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
else
  echo "==> Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# 配置 npm 镜像（中国大陆可加速）
echo "==> Configuring npm registry..."
npm config set registry https://registry.npmmirror.com || true

# 安装 Wails CLI
echo "==> Installing Wails CLI..."
export PATH="$HOME/go/bin:/usr/local/go/bin:$PATH"
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# 验证
echo ""
echo "==> Verification:"
echo "Go:        $(go version)"
echo "Node:      $(node -v)"
echo "npm:       $(npm -v)"
echo "Wails:     $(wails version)"
echo "makensis:  $(makensis -VERSION)"

echo ""
echo "Setup complete. Please run 'source ~/.bashrc' or re-login before building."
