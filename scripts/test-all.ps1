param(
  [switch]$SkipFrontendE2E,
  [switch]$SkipCodexSmoke,
  [switch]$RunVnc,
  [int]$BackendPort = 8000,
  [int]$FrontendPort = 3000
)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$frontend = Join-Path $repo "frontend"
$scripts = Join-Path $repo "scripts"
$backendOut = Join-Path $repo "tmp-test-backend.out.log"
$backendErr = Join-Path $repo "tmp-test-backend.err.log"
$frontendOut = Join-Path $repo "tmp-test-frontend.out.log"
$frontendErr = Join-Path $repo "tmp-test-frontend.err.log"
$started = @()

function Step($name) {
  Write-Host ""
  Write-Host "==> $name" -ForegroundColor Cyan
}

function Run($name, $scriptBlock) {
  Step $name
  & $scriptBlock
  if ($LASTEXITCODE -ne 0) {
    throw "$name failed with exit code $LASTEXITCODE"
  }
}

function Wait-Http($url, $name, $timeoutSeconds = 45) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $res = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 5
      if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 500) { return }
    } catch {
      Start-Sleep -Milliseconds 750
    }
  }
  throw "$name did not become ready at $url"
}

function Assert-PortFree($port) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    throw "Port $port is already in use. Stop that service or pass a different port."
  }
}

function Stop-Started {
  try {
    $backendListener = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
    if ($backendListener) {
      # The backend exit endpoint closes every PTY before terminating the worker.
      # Keep force-stop below as a bounded fallback for a hung test server.
      Invoke-RestMethod -Method Post "http://127.0.0.1:$BackendPort/exit" -TimeoutSec 5 | Out-Null
      $deadline = (Get-Date).AddSeconds(5)
      while ((Get-Date) -lt $deadline -and (Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 100
      }
    }
  } catch {
    # Best-effort graceful cleanup; force-stop below is the fallback.
  }
  foreach ($p in $started) {
    try {
      if ($p -and -not $p.HasExited) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      }
    } catch {
      # Best-effort cleanup.
    }
  }
  foreach ($port in @($BackendPort, $FrontendPort)) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
      Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}

try {
  Push-Location $repo
  Run "Backend unit tests" { python -m pytest backend/tests test -q }

  Push-Location $frontend
  Run "Frontend lint" { npm run lint }

  Run "Frontend production build" { npm run build }

  Run "Frontend typecheck" { npx tsc --noEmit }
  Pop-Location

  Assert-PortFree $BackendPort
  Assert-PortFree $FrontendPort

  Step "Start backend"
  Remove-Item $backendOut, $backendErr -ErrorAction SilentlyContinue
  $backend = Start-Process -FilePath python -ArgumentList @("-m", "uvicorn", "backend.main:app", "--port", "$BackendPort") -WorkingDirectory $repo -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr -PassThru -WindowStyle Hidden
  $started += $backend
  Wait-Http "http://127.0.0.1:$BackendPort/api/agent/handshake" "backend"

  Step "Terminal API smoke"
  $base = "http://127.0.0.1:$BackendPort"
  $token = (Invoke-RestMethod "$base/api/agent/handshake").token
  $headers = @{ Authorization = "Bearer $token" }
  $term = Invoke-RestMethod -Method Post "$base/api/agent/terminals" -Headers $headers -ContentType "application/json" -Body '{"type":"local","name":"test-all","transient":true,"user_visible":false}'
  try {
    $input = Invoke-RestMethod -Method Post "$base/api/agent/terminals/$($term.id)/input" -Headers $headers -ContentType "application/json" -Body '{"data":"echo WINKTERM_SMOKE","enter":true,"wait":true,"timeout":10,"idle":0.5}'
    $snap = Invoke-RestMethod "$base/api/agent/terminals/$($term.id)/snapshot" -Headers $headers
    $visible = (($input.output | Out-String) + "`n" + ($snap.output | Out-String))
    if ($visible -notmatch "WINKTERM_SMOKE") {
      throw "terminal smoke did not see WINKTERM_SMOKE"
    }
  } finally {
    Invoke-RestMethod -Method Delete "$base/api/agent/terminals/$($term.id)" -Headers $headers | Out-Null
  }

  Run "Terminal WebSocket reconnect smoke" {
    python scripts\test_terminal_ws_reconnect.py `
      --ws-base "ws://127.0.0.1:$BackendPort/ws/terminal" `
      --http-base "http://127.0.0.1:$BackendPort"
  }

  if (-not $SkipCodexSmoke) {
    Run "Codex chat WebSocket smoke" { python scripts\test_codex_ws_smoke.py --ws-url "ws://127.0.0.1:$BackendPort/ws/chat" }

    Run "Codex tool-call WebSocket smoke" { python scripts\test_codex_ws_smoke.py --ws-url "ws://127.0.0.1:$BackendPort/ws/chat" --with-tools }
  }

  if ($RunVnc) {
    Run "VNC WebSocket smoke" { python scripts\test_vnc_ws.py --base "ws://127.0.0.1:$BackendPort" --connect-timeout 10 --handshake-timeout 20 }
  } else {
    Write-Host ""
    Write-Host "==> VNC WebSocket smoke skipped (pass -RunVnc when a configured VNC target is available)" -ForegroundColor Yellow
  }

  if (-not $SkipFrontendE2E) {
    Step "Ensure scripts dependencies"
    Push-Location $scripts
    if (-not (Test-Path "node_modules\puppeteer-core")) {
      Run "Install scripts dependencies" { npm ci --no-audit --no-fund }
    }
    Pop-Location

    Step "Start frontend"
    Remove-Item $frontendOut, $frontendErr -ErrorAction SilentlyContinue
    $frontendProcess = Start-Process -FilePath npm.cmd -ArgumentList @("run", "dev", "--", "--port", "$FrontendPort") -WorkingDirectory $frontend -RedirectStandardOutput $frontendOut -RedirectStandardError $frontendErr -PassThru -WindowStyle Hidden
    $started += $frontendProcess
    Wait-Http "http://127.0.0.1:$FrontendPort" "frontend"

    Push-Location $scripts
    $env:WINKTERM_APP = "http://127.0.0.1:$FrontendPort"
    $env:WINKTERM_API = "http://127.0.0.1:$BackendPort"
    if (-not $env:CHROME_PATH -and (Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe")) {
      $env:CHROME_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe"
    }
    Run "Browser E2E" { node test-agent-docs-e2e.mjs }
    if (-not $SkipCodexSmoke) {
      Run "Terminal AI browser E2E" { node test-terminal-ai-e2e.mjs }
    }
    Pop-Location
  }

  Write-Host ""
  Write-Host "ALL TESTS PASSED" -ForegroundColor Green
} finally {
  Stop-Started
  while ((Get-Location).Path -ne $repo.Path) {
    Pop-Location
  }
}
