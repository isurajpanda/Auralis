# One-click launcher — WSL Asterisk + Backend + Frontend + Status
# Run from repo root: powershell -ExecutionPolicy Bypass -File scripts\run-all.ps1
param(
  [switch]$Stop,
  [int]$BackendPort = 9000,
  [switch]$NoAsterisk
)

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Write-Status($label, $ok, $msg) {
  $color = if ($ok) { "Green" } else { "Red" }
  $icon = if ($ok) { "[OK]" } else { "[X]" }
  Write-Host ("{0} {1}: {2}" -f $icon, $label, $msg) -ForegroundColor $color
}

if ($Stop) {
  Write-Host "Stopping all..." -ForegroundColor Yellow
  Get-Job | Stop-Job -PassThru | Remove-Job -Force
  Get-Process -Name "python","node" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*voice-clone-guard*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  wsl bash -c 'sudo pkill asterisk; echo stopped' 2>$null | Out-Null
  Write-Host "Stopped." -ForegroundColor Green
  exit 0
}

Write-Host "=== Voice Clone Guard - run-all ===" -ForegroundColor Cyan
Write-Host "Root: $root" -ForegroundColor Gray

# 1. Asterisk in WSL
if (-not $NoAsterisk) {
  Write-Host ""
  Write-Host "[1/3] WSL Asterisk..." -ForegroundColor Cyan
  $wslOk = $false
  try { wsl --status 2>$null | Out-Null; $wslOk = $true } catch {}
  if (-not $wslOk) {
    Write-Status "WSL" $false "not found - run wsl --install"
  } else {
    $cmd = 'sudo asterisk -rx ''core show version'' 2>/dev/null | grep -q Asterisk && echo ok || (sudo service asterisk start 2>/dev/null; sleep 2; sudo asterisk -rx ''core show version'' 2>&1 | head -1)'
    $started = wsl bash -c $cmd
    Start-Sleep 2
    $ver = wsl bash -c 'sudo asterisk -rx ''core show version'' 2>&1 | head -1'
    $ok = $ver -like "*Asterisk*"
    Write-Status "Asterisk" $ok $ver
    if (-not $ok) { Write-Host "  Try: wsl bash ./scripts/setup-asterisk-wsl.sh" -ForegroundColor Yellow }
  }
} else {
  Write-Host "Skipping Asterisk (-NoAsterisk)" -ForegroundColor Gray
}

# 2. Backend
Write-Host ""
Write-Host "[2/3] Backend (FastAPI) on :$BackendPort..." -ForegroundColor Cyan
if (-not (Test-Path "$root\backend\.env")) {
  Copy-Item "$root\backend\.env.example" "$root\backend\.env" -Force
  Write-Host "  Created backend\.env from .env.example" -ForegroundColor Gray
}
$proc = Get-NetTCPConnection -LocalPort $BackendPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
if ($proc) { Write-Host "  Port $BackendPort in use (PID $proc) - will try anyway, or: taskkill /PID $proc /F" -ForegroundColor Yellow }

$backendJob = Start-Job -Name "voice-guard-backend" -ScriptBlock {
  param($root, $port)
  Set-Location "$root\backend"
  python -m uvicorn app.main:app --reload --port $port --host 0.0.0.0
} -ArgumentList $root, $BackendPort

Start-Sleep 4
$health = $null
try { $health = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BackendPort/health" -TimeoutSec 5 | Select-Object -ExpandProperty Content } catch { $health = $null }
$ok = $health -like "*models_loaded*"
$healthMsg = if ($health) { $health } else { "no response (port busy? try -BackendPort 8001)" }
Write-Status "Backend" $ok ("http://localhost:$BackendPort/health -> " + $healthMsg)
if ($ok) { Write-Host "  Docs: http://localhost:$BackendPort/docs" -ForegroundColor Gray }

# 3. Frontend
Write-Host ""
Write-Host "[3/3] Frontend (Vite) on :5173..." -ForegroundColor Cyan
$frontendJob = Start-Job -Name "voice-guard-frontend" -ScriptBlock {
  param($root)
  Set-Location "$root\frontend"
  npm run dev -- --host 0.0.0.0 --port 5173
} -ArgumentList $root

Start-Sleep 5
$frontOk = $false
try { $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:5173" -TimeoutSec 5; $frontOk = $r.StatusCode -eq 200 } catch { $frontOk = $false }
if (-not $frontOk) { $frontOk = (Get-Job -Name "voice-guard-frontend").State -eq "Running" }
Write-Status "Frontend" $frontOk "http://localhost:5173  (Dialer=/  Dashboard=/dashboard)"

# Summary
Write-Host ""
Write-Host "=== STATUS ===" -ForegroundColor Cyan
Get-Job | Format-Table Name, State, HasMoreData -AutoSize
Write-Host ""
Write-Host "Asterisk: ws://localhost:8088/ws  ARI http://localhost:8088/ari (voice-guard/voice-guard-secret)  SIP 1001-1005/1001pass" -ForegroundColor Gray
Write-Host "Backend:  http://localhost:$BackendPort  health /health  ws /ws/{session_id}  signal /ws/signal/{ext}" -ForegroundColor Gray
Write-Host "Frontend: http://localhost:5173  /dialer  /dashboard" -ForegroundColor Gray
Write-Host ""
Write-Host "Logs: Get-Job | Receive-Job -Keep" -ForegroundColor Yellow
Write-Host "Stop: powershell -File scripts\run-all.ps1 -Stop" -ForegroundColor Yellow

Write-Host ""
Write-Host "Tailing backend health for 5s..." -ForegroundColor Gray
for ($i=0; $i -lt 5; $i++) {
  try {
    $h = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$BackendPort/health" -TimeoutSec 2 | Select-Object -ExpandProperty Content
    Write-Host "  health: $h" -ForegroundColor DarkGray
  } catch { Write-Host "  health: ..." -ForegroundColor DarkGray }
  Start-Sleep 1
}
