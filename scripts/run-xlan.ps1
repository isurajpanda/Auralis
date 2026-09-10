# surajpanda.qzz.io launcher - nginx 443 (frontend built -> nginx/html) + backend 9000 + optional WSL asterisk
# Run from repo root: powershell -ExecutionPolicy Bypass -File scripts\run-xlan.ps1
# Requires admin for nginx 80/443 + hosts (surajpanda.qzz.io -> 127.0.0.1)
param(
  [switch]$Stop,
  [switch]$NoAsterisk,
  [switch]$SkipBuild
)

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path $PSScriptRoot -Parent
$nginxRoot = "C:\Users\estac\Desktop\Auralis\nginx-1.30.4"
Set-Location $root

function Write-Status($label, $ok, $msg) {
  $color = if ($ok) { "Green" } else { "Red" }
  $icon = if ($ok) { "[OK]" } else { "[X]" }
  Write-Host ("{0} {1}: {2}" -f $icon, $label, $msg) -ForegroundColor $color
}

if ($Stop) {
  Write-Host "Stopping surajpanda.qzz.io stack..." -ForegroundColor Yellow
  # nginx
  & "$nginxRoot\nginx.exe" -p $nginxRoot -s stop 2>$null
  taskkill /IM nginx.exe /F 2>$null | Out-Null
  Get-Job -Name "voice-guard-backend*" | Stop-Job -PassThru | Remove-Job -Force 2>$null
  Get-Process -Name python -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*voice-clone-guard*" } | Stop-Process -Force -ErrorAction SilentlyContinue
  if (-not $NoAsterisk) { wsl bash -c 'sudo pkill asterisk; echo stopped' 2>$null | Out-Null }
  Write-Host "Stopped." -ForegroundColor Green
  exit 0
}

Write-Host "=== Voice Clone Guard - surajpanda.qzz.io (nginx 443) ===" -ForegroundColor Cyan
Write-Host "Root: $root" -ForegroundColor Gray
Write-Host "Nginx: $nginxRoot" -ForegroundColor Gray

# 0. Hosts check
$hostsOk = (Get-Content "C:\Windows\System32\drivers\etc\hosts" -ErrorAction SilentlyContinue | Select-String "surajpanda.qzz.io")
if (-not $hostsOk) {
  Write-Host "Adding hosts entry 127.0.0.1 surajpanda.qzz.io (needs admin)..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -Command Add-Content -Path 'C:\Windows\System32\drivers\etc\hosts' -Value '127.0.0.1 surajpanda.qzz.io'; Add-Content -Path 'C:\Windows\System32\drivers\etc\hosts' -Value '::1 surajpanda.qzz.io'" -Wait
}

# 0b. Cert check
if (-not (Test-Path "$nginxRoot\conf\certs\surajpanda.qzz.io.crt")) {
  Write-Host "Cert missing at $nginxRoot\conf\certs\surajpanda.qzz.io.crt - regenerate via openssl req ..." -ForegroundColor Red
} else {
  # trust cert (once)
  $certInstalled = certutil -store Root | Select-String "surajpanda.qzz.io"
  if (-not $certInstalled) {
    Write-Host "Installing surajpanda.qzz.io cert to Trusted Root (admin)..." -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -Command certutil -addstore Root '$nginxRoot\conf\certs\surajpanda.qzz.io.crt'" -Wait
  }
}

# 1. Build frontend -> nginx/html
if (-not $SkipBuild) {
  Write-Host ""
  Write-Host "[1/4] Building frontend -> $nginxRoot\html ..." -ForegroundColor Cyan
  Push-Location "$root\frontend"
  npm run build
  if ($LASTEXITCODE -ne 0) { Write-Host "  build failed" -ForegroundColor Red; Pop-Location; exit 1 }
  Pop-Location
  # clean html (keep logs/temp) - only remove old built assets
  Remove-Item -Recurse -Force "$nginxRoot\html\assets" -ErrorAction SilentlyContinue
  Remove-Item -Force "$nginxRoot\html\index.html" -ErrorAction SilentlyContinue
  Copy-Item -Recurse -Force "$root\frontend\dist\*" "$nginxRoot\html\"
  if (-not (Test-Path "$nginxRoot\html\50x.html")) {
    Set-Content "$nginxRoot\html\50x.html" '<!doctype html><html><head><title>50x Service Unavailable</title></head><body><h1>Backend unavailable</h1><p>nginx surajpanda.qzz.io</p></body></html>'
  }
  Write-Status "Frontend" $true "$nginxRoot\html (built)"
} else {
  Write-Host "Skipping build (-SkipBuild)" -ForegroundColor Gray
}

# 2. Asterisk WSL (optional)
if (-not $NoAsterisk) {
  Write-Host ""
  Write-Host "[2/4] WSL Asterisk..." -ForegroundColor Cyan
  $wslOk = $false; try { wsl --status 2>$null | Out-Null; $wslOk = $true } catch {}
  if ($wslOk) {
    $ver = wsl bash -c 'sudo asterisk -rx ''core show version'' 2>&1 | head -1'
    $ok = $ver -like "*Asterisk*"
    if (-not $ok) {
      Write-Host "  Asterisk not running, trying start..." -ForegroundColor Yellow
      wsl bash -c 'sudo service asterisk start 2>/dev/null; sleep 2; sudo asterisk -rx ''core show version'' 2>&1 | head -1' | Out-Null
      $ver = wsl bash -c 'sudo asterisk -rx ''core show version'' 2>&1 | head -1'
      $ok = $ver -like "*Asterisk*"
    }
    Write-Status "Asterisk" $ok $ver
    if (-not $ok) { Write-Host "  Try: wsl bash ./scripts/setup-asterisk-wsl.sh" -ForegroundColor Yellow }
  }
} else { Write-Host "Skipping Asterisk (-NoAsterisk)" -ForegroundColor Gray }

# 3. Backend
Write-Host ""
Write-Host "[3/4] Backend FastAPI :9000 ..." -ForegroundColor Cyan
if (-not (Test-Path "$root\backend\.env")) { Copy-Item "$root\backend\.env.example" "$root\backend\.env" -Force }
# ensure ALLOW_ORIGINS includes https://surajpanda.qzz.io
$envContent = Get-Content "$root\backend\.env" -Raw -ErrorAction SilentlyContinue
if ($envContent -notlike "*surajpanda.qzz.io*") { Write-Host "  Tip: backend ALLOW_ORIGINS=* already covers https://surajpanda.qzz.io" -ForegroundColor Gray }

$backendJob = Start-Job -Name "voice-guard-backend-xlan" -ScriptBlock {
  param($root)
  Set-Location "$root\backend"
  python -m uvicorn app.main:app --reload --port 9000 --host 0.0.0.0
} -ArgumentList $root
Start-Sleep 4
$health = $null
try { $health = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9000/health" -TimeoutSec 5 | Select-Object -ExpandProperty Content } catch {}
$ok = $health -like "*models_loaded*"
Write-Status "Backend" $ok "http://127.0.0.1:9000/health -> $health"
if ($ok) { Write-Host "  Docs proxied at https://surajpanda.qzz.io/docs" -ForegroundColor Gray }

# 4. Nginx (443)
Write-Host ""
Write-Host "[4/4] Nginx https://surajpanda.qzz.io (80->443) ..." -ForegroundColor Cyan
# test config
$nginxTest = cmd /c "`"$nginxRoot\nginx.exe`" -p `"$nginxRoot`" -t 2>&1"
$testOk = ($LASTEXITCODE -eq 0) -or ($nginxTest -like "*test is successful*")
Write-Host "  $nginxTest" -ForegroundColor DarkGray
if (-not $testOk) { Write-Host "  nginx -t failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }

# stop old nginx if running, then start
& "$nginxRoot\nginx.exe" -p $nginxRoot -s stop 2>$null
Start-Sleep 1
taskkill /IM nginx.exe /F 2>$null | Out-Null
Start-Sleep 1
# start requires admin for 80/443
try {
  Start-Process -FilePath "$nginxRoot\nginx.exe" -ArgumentList "-p", $nginxRoot -WorkingDirectory $nginxRoot -Verb RunAs -WindowStyle Hidden
  Start-Sleep 2
} catch {
  # fallback without admin (may fail on 80/443)
  Start-Process -FilePath "$nginxRoot\nginx.exe" -ArgumentList "-p", $nginxRoot -WorkingDirectory $nginxRoot
  Start-Sleep 2
}

$nginxProc = Get-Process nginx -ErrorAction SilentlyContinue
$nginxOk = $null -ne $nginxProc
Write-Status "Nginx" $nginxOk "https://surajpanda.qzz.io (frontend) + https://surajpanda.qzz.io/api + https://surajpanda.qzz.io/ws + https://surajpanda.qzz.io/ari + wss://surajpanda.qzz.io/asterisk/ws"
if ($nginxOk) {
  # probe frontend via https (curl -k works on PS 5.1, no SkipCertificateCheck)
  $jh = cmd /c "curl.exe -k -s https://surajpanda.qzz.io/health 2>nul"
  Write-Host "  https://surajpanda.qzz.io/health -> $jh" -ForegroundColor DarkGray
  $fh = cmd /c "curl.exe -k -s -I https://surajpanda.qzz.io/ 2>nul | findstr HTTP"
  Write-Host "  https://surajpanda.qzz.io/ $fh" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== STATUS ===" -ForegroundColor Cyan
Get-Job | Format-Table Name,State,HasMoreData -AutoSize
Write-Host ""
Write-Host "Frontend: https://surajpanda.qzz.io/  (also http://surajpanda.qzz.io -> 301)" -ForegroundColor Green
Write-Host "Backend : https://surajpanda.qzz.io/health  https://surajpanda.qzz.io/docs  https://surajpanda.qzz.io/api/*  wss://surajpanda.qzz.io/ws/*" -ForegroundColor Green
Write-Host "Asterisk: wss://surajpanda.qzz.io/asterisk/ws  https://surajpanda.qzz.io/ari/  (proxied to 127.0.0.1:8088)" -ForegroundColor Green
Write-Host "Built  : $nginxRoot\html (from frontend/dist)" -ForegroundColor Gray
Write-Host "Cert   : $nginxRoot\conf\certs\surajpanda.qzz.io.crt (SAN DNS:surajpanda.qzz.io + IP 192.168.1.73/100 + 127.0.0.1, trusted in Root)" -ForegroundColor Gray
Write-Host "Hosts  : C:\Windows\System32\drivers\etc\hosts must have 127.0.0.1 surajpanda.qzz.io (other LAN devices: add 192.168.1.100 surajpanda.qzz.io)" -ForegroundColor Yellow
Write-Host ""
Write-Host "Logs: Get-Job | Receive-Job -Keep  |  nginx logs: $nginxRoot\logs\error.log" -ForegroundColor Yellow
Write-Host "Stop: powershell -File scripts\run-xlan.ps1 -Stop" -ForegroundColor Yellow
Write-Host "Rebuild frontend only: npm run build && Copy-Item -Recurse -Force frontend\dist\* $nginxRoot\html\ && $nginxRoot\nginx.exe -p $nginxRoot -s reload" -ForegroundColor Gray
