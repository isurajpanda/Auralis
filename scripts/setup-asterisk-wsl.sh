#!/bin/bash
# Run INSIDE WSL Ubuntu (Debian) — installs Asterisk and copies voice-clone-guard config
# Usage from Windows: wsl bash ./scripts/setup-asterisk-wsl.sh
# Or: wsl -- bash -c "cd /mnt/c/Users/estac/Desktop/Auralis/voice-clone-guard && bash scripts/setup-asterisk-wsl.sh"

set -e
echo "[WSL] Updating apt..."
sudo apt-get update

echo "[WSL] Installing Asterisk..."
sudo apt-get install -y asterisk
# pjsip is included in asterisk on Ubuntu (res_pjsip); no separate asterisk-pjsip package

echo "[WSL] Stopping service to copy config..."
sudo systemctl stop asterisk 2>/dev/null || sudo service asterisk stop 2>/dev/null || true
# OR if no systemd: pkill asterisk
sudo pkill asterisk || true

# Resolve repo path when called via /mnt/c/...
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "[WSL] Repo: $REPO_DIR"
CONFIG_SRC="$REPO_DIR/asterisk/config"
CONFIG_DST="/etc/asterisk"

echo "[WSL] Copying configs $CONFIG_SRC -> $CONFIG_DST"
sudo cp -v "$CONFIG_SRC/pjsip.conf" "$CONFIG_DST/pjsip.conf"
sudo cp -v "$CONFIG_SRC/extensions.conf" "$CONFIG_DST/extensions.conf"
sudo cp -v "$CONFIG_SRC/http.conf" "$CONFIG_DST/http.conf"
sudo cp -v "$CONFIG_SRC/ari.conf" "$CONFIG_DST/ari.conf"
sudo cp -v "$CONFIG_SRC/rtp.conf" "$CONFIG_DST/rtp.conf"
sudo cp -v "$CONFIG_SRC/logger.conf" "$CONFIG_DST/logger.conf"
sudo chown -R asterisk:asterisk "$CONFIG_DST" 2>/dev/null || true

echo "[WSL] Enabling Asterisk..."
sudo systemctl enable asterisk 2>/dev/null || true

echo "[WSL] Starting Asterisk..."
sudo systemctl start asterisk 2>/dev/null || sudo service asterisk start 2>/dev/null || sudo asterisk -f &

sleep 3
echo "[WSL] Checking..."
sudo asterisk -rx "core show version" || true
sudo asterisk -rx "pjsip show endpoints" || true
sudo asterisk -rx "http show status" || true

echo "[WSL] Done. From Windows check: curl http://localhost:8088/ari/asterisk/info -u voice-guard:voice-guard-secret"
echo "[WSL] SIP WS: ws://localhost:8088/ws  ARI: http://localhost:8088/ari  UDP: localhost:5060"
