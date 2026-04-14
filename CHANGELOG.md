# Changelog

All notable changes to iridium-sniffer Mission Control — NXC2 Edition.

---

## v1.3 — 2026-04-05

### 3D Globe — Interactive Markers

- **Hover tooltips** — moving the mouse over any globe entity shows an instant tooltip with key details (name, type, coordinates). Works on all entity types: TLE satellites, beam footprints, mobile terminals (MT), aircraft, receiver, satellite positions, and observer
- **Click detail panels** — clicking any entity opens a styled info panel with full metadata: orbital elements for satellites, beam ID/center coordinates for beams, ACARS data for aircraft, HDOP/fix quality for receiver, and Doppler-derived position data for satellite positions
- **Entity metadata (`_meta`)** — all globe entities now carry a `_meta` property with structured type and data fields, enabling consistent tooltip and info panel rendering across all 7 entity types
- **Close-on-click-away** — the info panel automatically closes when clicking empty space on the globe

---

## v1.2 — 2026-04-05

### Reliability — Graceful Start/Stop

- **Non-fatal optional feature init** — Web Map, ZMQ PUB, and GSMTAP initialization failures now warn and disable the feature instead of killing the entire capture process. Capture continues normally without the failed feature.
- **Immediate port release on shutdown** — Web map (port 8888), ZMQ PUB (port 7006), and GSMTAP sockets are now closed *before* draining processing queues, ensuring ports are free for immediate restart
- **ZMQ linger=0** — ZMQ PUB socket sets `ZMQ_LINGER=0` so `zmq_close()` releases the port instantly instead of waiting for pending messages
- **SO_REUSEPORT** — Web map server socket now sets `SO_REUSEPORT` (where available) alongside `SO_REUSEADDR` for faster port reuse on Linux
- **Race-safe ZMQ shutdown** — ZMQ PUB socket pointer is NULLed before closing, preventing use-after-free if the output thread is still active
- **GUI orphan cleanup** — Mission Control kills any orphaned `iridium-sniffer` processes before launching a new capture, preventing port conflicts
- **GUI SIGKILL fallback** — `api_stop` now handles `wait(timeout=5)` expiration with a SIGKILL fallback, ensuring the process is always terminated and ports are freed

---

## v1.1 — 2026-04-04

### 3D Globe — New Features

- **3D Globe integration** — CesiumJS + satellite.js visualization showing all 66 Iridium NEXT satellites at real orbital positions with SGP4 propagation, orbit tracks, and beam coverage ellipses
- **Globe enable/disable toggle** — checkbox in the 3D Globe tab header to enable or disable globe rendering without losing state
- **Web map data overlay** — live projection of web map data (beams, MT positions, aircraft, receiver, satellite positions) onto the 3D globe via Flask proxy (`/api/webmap/state`)
- **Sighted satellite filter** — globe filters to show only satellites currently detected by the receiver, driven by web map satellite data
- **Map style switching** — Satellite (Bing Maps via Cesium Ion), OpenStreetMap, and Dark basemap options
- **Cesium Ion token support** — configurable API token for Bing Maps satellite imagery; falls back to OpenStreetMap when no token is set
- **Lazy loading** — CesiumJS (~4 MB) only downloaded when the 3D Globe tab is first opened

### 3D Globe — Web Map Overlay Layers

Each layer is individually toggleable via checkboxes in the globe tab header:

- **WM Beams** — red ellipses (350 km radius) at beam center positions from IRA frames
- **MT** — orange markers for mobile terminal positions from paging messages
- **Aircraft** — cyan arrow icons with polyline track history from ACARS correlation
- **Receiver** — purple marker for Doppler-solved receiver position
- **Sat Pos** — yellow markers for satellite positions (deduplicated)

### 3D Globe — Bug Fixes

- Fixed CesiumJS crash (`RangeError: invalid array length`) when no Cesium Ion token is configured — Bing Maps imagery failure no longer corrupts tile arrays
- Fixed `startAnimation()` argument order bug that prevented animation from starting
- Fixed invisible web map entities — increased marker sizes and improved color contrast

### Mission Control GUI

- **Status indicator** (`wmStatus`) shows web map connection state and error feedback
- **Web map proxy endpoint** (`/api/webmap/state`) in Flask backend for CORS-safe access to the C binary's web map API

### Build System

- Updated `build-wsl.sh` with NVIDIA WSL2 GPU detection and OpenCL ICD configuration logic

---

## v1.0 — 2026-03-20

Initial NXC2 Edition release. Mission Control GUI with Flask + Socket.IO backend.

### Features

- **Mission Control GUI** — single-page browser dashboard on port 5050
- **RAW Output tab** — live stream of demodulated RAW lines from stdout
- **System Log tab** — stderr stats, verbose diagnostics, and GUI messages
- **Spectrum tab** — live RF spectrum showing detected burst activity
- **Constellation tab** — DQPSK I/Q scatter plot showing demodulation quality
- **Decoded Data tab** — structured frame table with type filtering and SNR
- **SDR device scanning** — auto-detect and list available SDR interfaces
- **Start/Stop control** — configure and launch iridium-sniffer from the GUI
- **PowerShell launcher** (`Start-MissionControl.ps1`) — one-command startup on Windows/WSL
- **Dark cyber theme** — consistent dark UI across all tabs
