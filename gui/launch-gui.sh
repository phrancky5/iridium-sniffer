#!/bin/bash
# ============================================================================
# iridium-sniffer Mission Control — Launcher
# ============================================================================
# Sets up an isolated Python virtual environment in gui/venv/ and launches
# the Flask web GUI. Opens in your browser at http://localhost:5000
#
# This does NOT touch any system-wide Python packages. The venv is local
# to this gui/ folder. Your Flask app in f:\intercept is not affected.
#
# Usage:
#   From WSL:
#     cd /mnt/f/HAMAPPS/iridium-sniffer-master/iridium-sniffer-master
#     chmod +x gui/launch-gui.sh
#     ./gui/launch-gui.sh
#
#   Custom port:
#     ./gui/launch-gui.sh 8080
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/venv"
PORT="${1:-5000}"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║   IRIDIUM SNIFFER — MISSION CONTROL         ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════════╝${NC}"
echo ""

# -------------------------------------------------------------------
# Step 1: Ensure python3 + venv are available
# -------------------------------------------------------------------
if ! command -v python3 &>/dev/null; then
    echo -e "${RED}[ERROR]${NC} python3 not found. Install with: sudo apt install python3 python3-venv"
    exit 1
fi

# -------------------------------------------------------------------
# Step 2: Create venv if it doesn't exist
# -------------------------------------------------------------------
if [ ! -d "${VENV_DIR}" ]; then
    echo -e "${CYAN}[SETUP]${NC} Creating isolated Python virtual environment..."
    python3 -m venv "${VENV_DIR}"
    echo -e "${GREEN}[OK]${NC}    venv created at ${VENV_DIR}"
fi

# -------------------------------------------------------------------
# Step 3: Activate venv and install dependencies
# -------------------------------------------------------------------
source "${VENV_DIR}/bin/activate"

# Check if flask is installed already
if ! python3 -c "import flask" 2>/dev/null; then
    echo -e "${CYAN}[SETUP]${NC} Installing Flask + Socket.IO into venv..."
    pip install --quiet --upgrade pip
    pip install --quiet -r "${SCRIPT_DIR}/requirements.txt"
    echo -e "${GREEN}[OK]${NC}    Dependencies installed in venv (isolated)"
fi

# -------------------------------------------------------------------
# Step 4: Launch
# -------------------------------------------------------------------
echo ""
echo -e "${GREEN}  Open in browser: ${NC}http://localhost:${PORT}"
echo -e "${GREEN}  Binary:          ${NC}$(dirname "${SCRIPT_DIR}")/build/iridium-sniffer"
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop the GUI server"
echo ""

cd "${SCRIPT_DIR}"
exec python3 app.py "${PORT}"
