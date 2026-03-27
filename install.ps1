# OpenClaw Agent Monitor - Windows installer
$ErrorActionPreference = "Stop"

$repo = "https://github.com/wuchengfeng/agent-monitor.git"
$installDir = "$env:USERPROFILE\.openclaw-agent-monitor"

# Check node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js not found. Install from https://nodejs.org (v18+)"
    exit 1
}
$nodeVer = [int](node -e "process.stdout.write(process.versions.node.split('.')[0])")
if ($nodeVer -lt 18) {
    Write-Error "Node.js v18+ required (current: $(node -v))"
    exit 1
}

# Clone or update
if (Test-Path "$installDir\.git") {
    Write-Host "Updating agent-monitor..."
    git -C $installDir pull --ff-only
} else {
    Write-Host "Installing agent-monitor..."
    git clone $repo $installDir
}

Write-Host ""
Write-Host "Starting at http://localhost:4000 ..."
Write-Host "Press Ctrl+C to stop."
Write-Host ""

# Open browser after short delay
Start-Job { Start-Sleep 1; Start-Process "http://localhost:4000" } | Out-Null

Set-Location $installDir
node server.js
