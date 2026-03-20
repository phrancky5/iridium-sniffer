#!/bin/bash
# ============================================================================
# iridium-sniffer WSL Build Script
# ============================================================================
# Builds iridium-sniffer as a standalone application inside WSL.
# The binary stays in the local build/ directory — nothing is installed
# system-wide, so existing SDR applications are not affected.
#
# Usage:
#   From WSL:
#     cd /mnt/f/HAMAPPS/iridium-sniffer-master/iridium-sniffer-master
#     chmod +x build-wsl.sh
#     ./build-wsl.sh
#
#   Or from Windows PowerShell:
#     wsl -e bash -c "cd /mnt/f/HAMAPPS/iridium-sniffer-master/iridium-sniffer-master && chmod +x build-wsl.sh && ./build-wsl.sh"
#
# After building, run with:
#     ./build/iridium-sniffer --help
#     ./build/iridium-sniffer -f recording.cf32
#     ./build/iridium-sniffer --list
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
NPROC=$(nproc 2>/dev/null || echo 4)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

echo ""
echo "============================================"
echo "  iridium-sniffer — WSL Standalone Build"
echo "============================================"
echo ""

# -------------------------------------------------------------------
# Step 1: Install build-time dependencies
# -------------------------------------------------------------------
# Only -dev packages (headers) and build tools are installed.
# These do NOT replace or modify any existing SDR runtime libraries.
# If you already have libhackrf0, libsoapysdr0.8, etc. installed
# from other SDR apps, they remain untouched.
# -------------------------------------------------------------------

info "Installing build dependencies (headers + tools only)..."
info "This will NOT modify existing SDR runtime libraries."
echo ""

sudo apt-get update -qq

# Core build tools + required library
sudo apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    pkg-config \
    libfftw3-dev

# SDR backend headers (install what's available, skip what's not)
# These -dev packages only add header files for compilation.
SDR_PACKAGES=""
for pkg in libhackrf-dev libbladerf-dev libuhd-dev libsoapysdr-dev; do
    if apt-cache show "$pkg" >/dev/null 2>&1; then
        SDR_PACKAGES="$SDR_PACKAGES $pkg"
    else
        warn "Package $pkg not available in apt — skipping"
    fi
done

if [ -n "$SDR_PACKAGES" ]; then
    info "Installing SDR dev packages:$SDR_PACKAGES"
    sudo apt-get install -y --no-install-recommends $SDR_PACKAGES
else
    warn "No SDR dev packages found. Live capture won't be available."
    warn "You can still process IQ files."
fi

# Optional: ZMQ for multi-consumer output
if apt-cache show libzmq3-dev >/dev/null 2>&1; then
    info "Installing ZMQ support..."
    sudo apt-get install -y --no-install-recommends libzmq3-dev
fi

# Optional: libacars for ARINC-622/ADS-C/CPDLC decoding
if apt-cache show libacars-dev >/dev/null 2>&1; then
    info "Installing libacars support..."
    sudo apt-get install -y --no-install-recommends libacars-dev
elif apt-cache show libacars2-dev >/dev/null 2>&1; then
    info "Installing libacars2 support..."
    sudo apt-get install -y --no-install-recommends libacars2-dev
fi

echo ""
ok "Dependencies installed."

# -------------------------------------------------------------------
# Step 2: Configure with CMake (local build, no GPU in WSL)
# -------------------------------------------------------------------

info "Configuring build in ${BUILD_DIR}..."

mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

# GPU acceleration is disabled by default for WSL since most WSL
# environments lack OpenCL/Vulkan passthrough. If your WSL has
# GPU support (WSL2 + NVIDIA), change -DUSE_OPENCL=OFF to ON.
cmake "${SCRIPT_DIR}" \
    -DCMAKE_BUILD_TYPE=RelWithDebInfo \
    -DUSE_OPENCL=OFF \
    -DUSE_VULKAN=OFF

echo ""
ok "CMake configuration complete."

# -------------------------------------------------------------------
# Step 3: Build
# -------------------------------------------------------------------

info "Building with ${NPROC} parallel jobs..."

cmake --build . -- -j"${NPROC}"

echo ""
ok "Build complete!"

# -------------------------------------------------------------------
# Step 4: Verify
# -------------------------------------------------------------------

if [ -x "${BUILD_DIR}/iridium-sniffer" ]; then
    echo ""
    echo "============================================"
    ok "Binary ready: ${BUILD_DIR}/iridium-sniffer"
    echo "============================================"
    echo ""
    info "Quick test:"
    "${BUILD_DIR}/iridium-sniffer" --help 2>&1 | head -5
    echo "  ..."
    echo ""
    info "Usage examples:"
    echo "  # Show help"
    echo "  ${BUILD_DIR}/iridium-sniffer --help"
    echo ""
    echo "  # List available SDR devices"
    echo "  ${BUILD_DIR}/iridium-sniffer --list"
    echo ""
    echo "  # Process an IQ recording"
    echo "  ${BUILD_DIR}/iridium-sniffer -f recording.cf32"
    echo ""
    echo "  # Live capture (SoapySDR)"
    echo "  ${BUILD_DIR}/iridium-sniffer -i soapy-0"
    echo ""
    echo "  # Live capture with web map"
    echo "  ${BUILD_DIR}/iridium-sniffer -i soapy-0 --web"
    echo ""
    echo "  # Built-in ACARS decoding"
    echo "  ${BUILD_DIR}/iridium-sniffer -i soapy-0 --acars"
    echo ""
    info "The binary is self-contained in the build/ directory."
    info "No system-wide installation was performed."
    info "To uninstall, simply delete the build/ folder."
else
    fail "Build failed — binary not found at ${BUILD_DIR}/iridium-sniffer"
fi
