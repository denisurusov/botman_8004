#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Full stack launcher: compiles contracts, starts Hardhat node, deploys
    contracts, registers agent cards on-chain, then spawns MCP servers.

.DESCRIPTION
    Steps:
      1. npx hardhat compile
      2. npx hardhat node  (background, waits until RPC is ready)
      3. npx hardhat run scripts/deploy-registries.js --network localhost
         → captures IdentityRegistry address from stdout
      4. npx hardhat run scripts/register-mocks.js --network localhost
         (passes address via env var)
      5. node agents_implementation/launch-agents.js
         (foreground – Ctrl-C shuts everything down)

.PARAMETER SkipCompile
    Skip the compile step (if contracts are already compiled).

.PARAMETER BasePort
    Passed through to launch-agents.js. Default: use ports from agent cards.

.EXAMPLE
    .\start.ps1
    .\start.ps1 -SkipCompile
#>

param(
    [switch]$SkipCompile,
    [int]$BasePort = 0
)

$ErrorActionPreference = 'Stop'
$Root   = $PSScriptRoot
$AgentsImpl = Join-Path $Root 'agents_implementation'

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "══════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "══════════════════════════════════════════════" -ForegroundColor Cyan
}

function Wait-Port([int]$port, [int]$timeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.Connect('127.0.0.1', $port)
            $tcp.Close()
            return $true
        } catch { Start-Sleep -Milliseconds 500 }
    }
    return $false
}

# ── Track child processes for cleanup ────────────────────────────────────────
$hardhatProc = $null

function Stop-All {
    Write-Host "`nCleaning up…" -ForegroundColor Yellow
    if ($hardhatProc -and -not $hardhatProc.HasExited) {
        Stop-Process -Id $hardhatProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped Hardhat node (pid $($hardhatProc.Id))"
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 – Compile
# ─────────────────────────────────────────────────────────────────────────────
if (-not $SkipCompile) {
    Write-Step "1/5  Compiling contracts"
    Push-Location $Root
    npx hardhat compile
    if ($LASTEXITCODE -ne 0) { Write-Error "Compile failed."; exit 1 }
    Pop-Location
} else {
    Write-Host "`n[skip] Compile step skipped." -ForegroundColor DarkGray
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 – Start Hardhat node in background
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "2/5  Starting Hardhat node"

$hardhatLog = Join-Path $Root 'hardhat-node.log'
$hardhatProc = Start-Process `
    -FilePath   'npx' `
    -ArgumentList @('hardhat', 'node') `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $hardhatLog `
    -RedirectStandardError  ($hardhatLog -replace '\.log$', '.err.log') `
    -NoNewWindow `
    -PassThru

Write-Host "  Hardhat node pid=$($hardhatProc.Id)  log=$hardhatLog"
Write-Host "  Waiting for RPC on port 8545…" -NoNewline

if (-not (Wait-Port 8545 60)) {
    Write-Host " TIMEOUT" -ForegroundColor Red
    Stop-All; exit 1
}
Write-Host " ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 – Deploy contracts, capture IdentityRegistry address
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "3/5  Deploying contracts"

Push-Location $Root
$deployOutput = npx hardhat run scripts/deploy-registries.js --network localhost 2>&1
Pop-Location

Write-Host $deployOutput

if ($LASTEXITCODE -ne 0) {
    Write-Error "Deployment failed."
    Stop-All; exit 1
}

# Parse "IdentityRegistry → 0x..." from output
$identityMatch = ($deployOutput | Select-String "IdentityRegistry\s*[->]\s*(0x[0-9a-fA-F]+)")
if (-not $identityMatch) {
    # Also try the unicode arrow that the script may emit
    $identityMatch = ($deployOutput | Select-String "(0x[0-9a-fA-F]{40})")
}
$identityAddr = if ($identityMatch) { $identityMatch.Matches[0].Groups[1].Value } else { $null }

if (-not $identityAddr) {
    Write-Error "Could not parse IdentityRegistry address from deploy output."
    Stop-All; exit 1
}

Write-Host "`n  IdentityRegistry address: $identityAddr" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 – Register agent cards on-chain
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "4/5  Registering agents on-chain"

Push-Location $Root
$env:IDENTITY_REGISTRY_ADDRESS = $identityAddr
npx hardhat run scripts/register-mocks.js --network localhost
if ($LASTEXITCODE -ne 0) {
    Write-Error "Agent registration failed."
    Stop-All; exit 1
}
Remove-Item Env:\IDENTITY_REGISTRY_ADDRESS -ErrorAction SilentlyContinue
Pop-Location

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 – Launch MCP servers (foreground – Ctrl-C stops everything)
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "5/5  Launching MCP agent servers"

$launchArgs = @("agents_implementation/launch-agents.js")
if ($BasePort -gt 0) { $launchArgs += "--base-port"; $launchArgs += "$BasePort" }

try {
    Push-Location $Root
    node @launchArgs
} finally {
    Pop-Location
    Stop-All
}

