# Start/stop Asterisk running in WSL from Windows — no Docker
# Usage: powershell -ExecutionPolicy Bypass -File scripts\start-asterisk-wsl.ps1
param(
  [switch]$Stop,
  [switch]$Logs,
  [switch]$Status,
  [switch]$Install
)

# 1. Check WSL
try { wsl --status 2>$null | Out-Null } catch {
  Write-Host "WSL not found. Enable it: wsl --install   (reboot required)" -ForegroundColor Red
  exit 1
}

if ($Install) {
  Write-Host "Installing Asterisk inside WSL..." -ForegroundColor Cyan
  wsl bash ./scripts/setup-asterisk-wsl.sh
  exit 0
}

if ($Status) {
  wsl bash -c "sudo asterisk -rx 'core show version'; sudo asterisk -rx 'pjsip show endpoints'; sudo asterisk -rx 'http show status'"
  Write-Host "`nFrom Windows: curl http://localhost:8088/ari/asterisk/info -u voice-guard:voice-guard-secret" -ForegroundColor Yellow
  exit 0
}

if ($Logs) {
  wsl bash -c "sudo tail -f /var/log/asterisk/messages 2>/dev/null || sudo journalctl -u asterisk -f"
  exit 0
}

if ($Stop) {
  Write-Host "Stopping Asterisk in WSL..." -ForegroundColor Yellow
  wsl bash -c "sudo systemctl stop asterisk 2>/dev/null || sudo service asterisk stop 2>/dev/null || sudo pkill asterisk; echo stopped"
  exit 0
}

# Default: Start
Write-Host "Starting Asterisk in WSL..." -ForegroundColor Cyan
wsl bash -c "sudo systemctl start asterisk 2>/dev/null || sudo service asterisk start 2>/dev/null || sudo asterisk -f & sleep 2; sudo asterisk -rx 'core show version'"
Write-Host "`nWSL Asterisk should be on: ws://localhost:8088/ws  http://localhost:8088/ari  UDP:5060" -ForegroundColor Green
Write-Host "Windows backend .env should have: ENABLE_ASTERISK=true  ARI_URL=http://localhost:8088/ari" -ForegroundColor Yellow
Write-Host "Check: .\scripts\start-asterisk-wsl.ps1 -Status" -ForegroundColor Gray
