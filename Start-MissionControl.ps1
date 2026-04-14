# ============================================================================
# iridium-sniffer Mission Control — PowerShell Launcher
# ============================================================================
# Starts the Flask GUI in WSL on port 5050 and opens the browser.
#
# Usage:
#   .\Start-MissionControl.ps1            # default port 5050
#   .\Start-MissionControl.ps1 -Port 8080 # custom port
# ============================================================================

param(
    [int]$Port = 5050
)

$ErrorActionPreference = "Stop"
$GuiPath = "/mnt/f/HAMAPPS/iridium-sniffer-master/iridium-sniffer-master/gui"

Write-Host ""
Write-Host "  IRIDIUM SNIFFER — Mission Control v1.3" -ForegroundColor Cyan
Write-Host "  ========================================" -ForegroundColor DarkCyan
Write-Host ""

# Check WSL is available
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    Write-Host "  ERROR: WSL not found. Install WSL first." -ForegroundColor Red
    exit 1
}

# Create venv + install deps if needed, then launch
$WslCmd = "cd $GuiPath || exit 1; if [ ! -d venv ]; then echo '  Creating Python venv...'; python3 -m venv venv; source venv/bin/activate; pip install --quiet -r requirements.txt; else source venv/bin/activate; fi; echo ''; python3 app.py $Port"

Write-Host "  Starting on http://localhost:$Port" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

# Open browser after a short delay
Start-Job -ScriptBlock {
    param($p)
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:$p"
} -ArgumentList $Port | Out-Null

# Run in WSL (foreground, Ctrl+C will stop it)
wsl bash -c $WslCmd
