# 3D Globe Integration — Iridium Sniffer Mission Control

**Date**: 2026-04-04  
**Source**: INTERCEPT `static/js/core/iridium-globe.js` (866 lines, CesiumJS + satellite.js)  
**Target**: Iridium Sniffer Mission Control (`gui/app.py` + `gui/templates/index.html`)

---

## Overview

Integrate INTERCEPT's 3D Globe visualization into the Iridium Sniffer's Mission Control GUI. The globe shows real Iridium NEXT constellation positions (66 satellites across 6 orbital planes at 780 km altitude) using CesiumJS for 3D Earth rendering and satellite.js for SGP4 orbital propagation.

**What the user gets:**
- 3D photorealistic Earth with all 66 Iridium satellites plotted at real positions
- Ground track orbit paths per satellite
- Beam coverage ellipses (2,350 km radius per sat)
- Observer location marker showing which satellites are visible
- Live animation at configurable time scale
- Session replay — show constellation as it was during a past capture
- Map style switching (Satellite/OSM/Dark), border/city overlays
- Click satellites for detail panel

**What already exists in the sniffer:**
- `doppler_pos.c` — Doppler-based receiver positioning (consumes IRA frames)
- `web_map.c` — Built-in Leaflet.js 2D map showing ring alerts + satellite ground tracks
- `--position` flag — Enables Doppler position solver
- 5 content tabs: RAW Output, System Log, Spectrum, Constellation (DQPSK), Decoded Data

---

## Architecture Decision

### Option A: Full Server-Side (like INTERCEPT) ❌
Copy INTERCEPT's Python backend endpoints (`/geo/tles`, `/geo/constellation`) that use `skyfield` for server-side SGP4. Requires adding `skyfield` + database dependencies to the sniffer.

### Option B: Client-Side Only (Recommended) ✅
Copy only the `iridium-globe.js` frontend module. It already:
- Loads CesiumJS + satellite.js from CDN (no server-side deps)
- Fetches TLEs directly from CelesTrak via a thin API proxy
- Computes all 66 satellite positions client-side using satellite.js SGP4
- Handles animation, beams, orbits, heatmaps independently

The sniffer backend only needs **one new endpoint** — a simple TLE proxy (to avoid CORS issues) + observer location pass-through.

---

## Implementation Plan

### Phase 1: Backend — Add TLE Proxy Endpoint

**File: `gui/app.py`**

Add one new endpoint that proxies CelesTrak TLE data and returns the observer location:

```python
import urllib.request
import json as _json

# ---- TLE cache (6-hour TTL) ----
_tle_cache = {"tles": [], "fetched_at": 0}
_tle_lock = threading.Lock()
TLE_TTL_S = 6 * 3600  # 6 hours
CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-NEXT&FORMAT=tle"

# ---- Observer location (in-memory, persisted to JSON file) ----
OBSERVER_FILE = GUI_DIR / "observer_location.json"

def _load_observer():
    """Load observer location from JSON file."""
    if OBSERVER_FILE.exists():
        try:
            with open(OBSERVER_FILE, "r") as f:
                return _json.load(f)
        except Exception:
            pass
    return None

def _save_observer(loc):
    """Save observer location to JSON file."""
    try:
        with open(OBSERVER_FILE, "w") as f:
            _json.dump(loc, f)
    except Exception as e:
        print(f"Warning: could not save observer location: {e}")


def _fetch_tles():
    """Fetch Iridium NEXT TLEs from CelesTrak."""
    req = urllib.request.Request(
        CELESTRAK_URL,
        headers={"User-Agent": "IridiumSniffer-MissionControl/1.0"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = resp.read(512_000).decode("utf-8", errors="replace")

    lines = [l.strip() for l in data.strip().split("\n") if l.strip()]
    tles = []
    i = 0
    while i + 2 < len(lines):
        name = lines[i]
        tle1 = lines[i + 1]
        tle2 = lines[i + 2]
        if tle1.startswith("1 ") and tle2.startswith("2 "):
            try:
                norad = int(tle1[2:7])
            except ValueError:
                norad = 0
            tles.append({
                "name": name,
                "norad": norad,
                "tle1": tle1,
                "tle2": tle2,
            })
            i += 3
        else:
            i += 1
    return tles


def _ensure_tles():
    """Return cached TLEs, refreshing from CelesTrak if stale (>6h)."""
    now = time.time()
    with _tle_lock:
        if _tle_cache["tles"] and (now - _tle_cache["fetched_at"]) < TLE_TTL_S:
            return _tle_cache["tles"]
    # Fetch outside lock
    try:
        tles = _fetch_tles()
        with _tle_lock:
            _tle_cache["tles"] = tles
            _tle_cache["fetched_at"] = time.time()
        return tles
    except Exception as e:
        print(f"TLE fetch failed: {e}")
        with _tle_lock:
            return _tle_cache["tles"]  # Return stale data if available


@app.route("/api/tles")
def api_tles():
    """Return Iridium NEXT TLEs for client-side globe rendering."""
    tles = _ensure_tles()
    observer = _load_observer()
    age_min = (time.time() - _tle_cache.get("fetched_at", 0)) / 60
    return jsonify({
        "status": "success",
        "tles": tles,
        "observer": observer,
        "tle_age_min": round(age_min, 1),
    })


@app.route("/api/tles/refresh", methods=["POST"])
def api_tles_refresh():
    """Force re-fetch TLEs from CelesTrak (bypass cache)."""
    try:
        tles = _fetch_tles()
        with _tle_lock:
            _tle_cache["tles"] = tles
            _tle_cache["fetched_at"] = time.time()
        return jsonify({
            "status": "success",
            "message": f"Fetched {len(tles)} Iridium NEXT TLEs",
            "tle_count": len(tles),
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 503


@app.route("/api/observer", methods=["GET", "POST"])
def api_observer():
    """Get or set observer location."""
    if request.method == "GET":
        loc = _load_observer()
        return jsonify({
            "status": "success",
            "location": loc,
            "configured": loc is not None,
        })
    data = request.get_json(force=True, silent=True) or {}
    lat = data.get("lat")
    lon = data.get("lon")
    if lat is None or lon is None:
        return jsonify({"status": "error", "message": "lat and lon required"}), 400
    try:
        loc = {
            "lat": float(lat),
            "lon": float(lon),
            "alt": float(data.get("alt", 0)),
            "name": str(data.get("name", "Observer"))[:100],
        }
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Invalid coordinates"}), 400
    _save_observer(loc)
    return jsonify({"status": "success", "location": loc})
```

**Requirements:** None. Uses only Python stdlib (`urllib.request`, `json`, `threading`). No new pip packages.

---

### Phase 2: Frontend — Copy Globe Module

**Step 2a: Create static file directory**

```
gui/
├── static/
│   └── js/
│       └── iridium-globe.js    ← Copy from INTERCEPT
├── templates/
│   └── index.html              ← Modify existing
└── app.py
```

**Step 2b: Copy `iridium-globe.js`**

Copy `f:\intercept\static\js\core\iridium-globe.js` to `gui/static/js/iridium-globe.js`.

**One modification required** — change the TLE fetch URL inside `createFromTLEs()`:

```javascript
// BEFORE (INTERCEPT path):
var res = await fetch('/iridium/geo/tles');

// AFTER (Sniffer path):
var res = await fetch('/api/tles');
```

**Step 2c: Configure Flask static files**

In `app.py`, update the Flask app to serve static files:

```python
app = Flask(__name__,
    template_folder=str(GUI_DIR / "templates"),
    static_folder=str(GUI_DIR / "static"),       # Add this
    static_url_path="/static"                     # Add this
)
```

---

### Phase 3: Frontend — Add Globe Tab to Template

**File: `gui/templates/index.html`**

#### 3a: Add the script tag (after Socket.IO CDN script)

```html
<!-- Socket.IO from CDN -->
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js" crossorigin="anonymous"></script>
<!-- 3D Globe module (CesiumJS + satellite.js loaded on demand from CDN) -->
<script src="/static/js/iridium-globe.js"></script>
```

#### 3b: Add "3D Globe" tab button

In the `.tab-bar` div, add after the existing "Decoded Data" tab:

```html
<div class="tab" data-tab="globe3d" onclick="switchTab(this)"
     title="3D satellite constellation visualization using real CelesTrak TLE data. Shows all 66 Iridium NEXT satellites, orbit tracks, and beam coverage.">
  🛰️ 3D Globe
</div>
```

#### 3c: Add globe container pane

After the decoded data container (inside `.terminal-wrap`):

```html
<!-- 3D Globe -->
<div class="globe-container" id="tabGlobe3d" style="display:none;">
  <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--bg-card-alt);border-bottom:1px solid var(--border);">
    <div style="display:flex;gap:8px;align-items:center;">
      <span id="globeStatus" style="color:var(--text-dim);font-size:12px;">Click to load globe</span>
      <span id="globeTleInfo" style="color:var(--text-dim);font-size:11px;"></span>
    </div>
    <div style="display:flex;gap:4px;">
      <select id="globeMode" onchange="updateGlobeMode()" style="padding:2px 6px;background:var(--bg-primary);color:var(--text-dim);border:1px solid var(--border);border-radius:4px;font-size:11px;">
        <option value="live">Live</option>
        <option value="session">Session Time</option>
      </select>
      <select id="globeMapStyle" onchange="setGlobeMapStyle(this.value)" style="padding:2px 6px;background:var(--bg-primary);color:var(--text-dim);border:1px solid var(--border);border-radius:4px;font-size:11px;">
        <option value="satellite">Satellite</option>
        <option value="osm">OpenStreetMap</option>
        <option value="dark">Dark</option>
      </select>
      <label style="color:var(--text-dim);font-size:11px;display:flex;align-items:center;gap:2px;">
        <input type="checkbox" id="globeBeams" checked onchange="IridiumGlobe.toggleBeams(this.checked)"> Beams
      </label>
      <label style="color:var(--text-dim);font-size:11px;display:flex;align-items:center;gap:2px;">
        <input type="checkbox" id="globeOrbits" checked onchange="IridiumGlobe.toggleOrbits(this.checked)"> Orbits
      </label>
      <button onclick="IridiumGlobe.resetView()" title="Reset view to observer location" 
        style="padding:2px 8px;background:var(--bg-card-alt);color:var(--text-dim);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:13px;">⌂</button>
      <button onclick="refreshGlobeTles()" title="Force refresh TLEs from CelesTrak" 
        style="padding:2px 8px;background:var(--bg-card-alt);color:var(--text-dim);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px;">🔄 TLE</button>
    </div>
  </div>
  <div id="globeContainer" style="width:100%;height:calc(100% - 32px);position:relative;"></div>
</div>
```

#### 3d: Add CSS for globe container

In the `<style>` section:

```css
/* ---- 3D Globe ---- */
.globe-container {
  position: absolute;
  inset: 0;
  background: #07071a;
}
.globe-container .cesium-viewer {
  width: 100% !important;
  height: 100% !important;
}
```

#### 3e: Add JavaScript functions

In the `<script>` section, add the globe control functions:

```javascript
/* ============================================================
 * 3D Globe Tab
 * ============================================================ */
let globeLoaded = false;

async function loadGlobe() {
    if (globeLoaded) return;
    const container = document.getElementById('globeContainer');
    if (!container) return;

    const statusEl = document.getElementById('globeStatus');
    if (statusEl) statusEl.textContent = '⏳ Loading CesiumJS (~4 MB)…';

    try {
        const mode = document.getElementById('globeMode').value;
        const epochMs = mode === 'session' ? _getSessionEpochMs() : null;
        const data = await IridiumGlobe.createFromTLEs(container, epochMs, 60);
        globeLoaded = true;

        if (statusEl) {
            const count = data.satellites ? data.satellites.length : 0;
            const vis = data.visible_count || 0;
            statusEl.textContent = `${count} satellites (${vis} visible)`;
            statusEl.style.color = 'var(--green)';
        }

        const tleInfo = document.getElementById('globeTleInfo');
        if (tleInfo && data.tle_age_min != null) {
            const age = Math.round(data.tle_age_min);
            tleInfo.textContent = `TLE age: ${age < 60 ? age + 'min' : Math.round(age/60) + 'h'}`;
            tleInfo.style.color = age > 360 ? 'var(--orange)' : 'var(--text-dim)';
        }

        // Start live animation
        IridiumGlobe.startAnimation(function(animData) {
            if (statusEl && animData.visible_count != null) {
                statusEl.textContent = `${animData.satellites.length} satellites (${animData.visible_count} visible)`;
            }
        });

    } catch (e) {
        console.error('Globe load failed:', e);
        if (statusEl) {
            statusEl.textContent = '❌ ' + e.message;
            statusEl.style.color = 'var(--red)';
        }
    }
}

function _getSessionEpochMs() {
    // If the sniffer is recording, use start_time as session epoch
    // Otherwise return null for live mode
    return null;  // Extend later: parse from capture state
}

function updateGlobeMode() {
    const mode = document.getElementById('globeMode').value;
    if (!globeLoaded) return;
    if (mode === 'live') {
        IridiumGlobe.recomputeAt(Date.now());
    } else {
        const epoch = _getSessionEpochMs();
        if (epoch) IridiumGlobe.recomputeAt(epoch);
    }
}

function setGlobeMapStyle(style) {
    if (IridiumGlobe) IridiumGlobe.setMapStyle(style);
}

async function refreshGlobeTles() {
    const statusEl = document.getElementById('globeStatus');
    if (statusEl) statusEl.textContent = '🔄 Refreshing TLEs…';
    try {
        const res = await fetch('/api/tles/refresh', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'success') {
            if (statusEl) statusEl.textContent = `✅ ${data.message}`;
            // Rebuild globe with fresh TLEs
            if (globeLoaded) {
                IridiumGlobe.dispose();
                globeLoaded = false;
                loadGlobe();
            }
        } else {
            if (statusEl) statusEl.textContent = '❌ ' + (data.message || 'Failed');
        }
    } catch (e) {
        if (statusEl) statusEl.textContent = '❌ ' + e.message;
    }
}
```

#### 3f: Modify `switchTab()` to trigger globe load

In the existing `switchTab()` function, add a case for the globe tab:

```javascript
function switchTab(el) {
    // ... existing tab switching logic ...
    
    // Lazy-load globe when tab is first opened
    if (tab === 'globe3d') {
        loadGlobe();
    }
}
```

Find the existing tab-to-pane mapping and add the globe entry:

```javascript
// Existing mapping (look for the object/switch that maps data-tab to element IDs):
// 'raw'           → '#termRaw'
// 'log'           → '#termLog'
// 'spectrum'      → '#tabSpectrum'
// 'constellation' → '#tabConstellation'
// 'decoded'       → '#tabDecoded'
// ADD:
// 'globe3d'       → '#tabGlobe3d'
```

---

### Phase 4: Cesium Ion Token (Optional but Recommended)

CesiumJS works without a token (uses default Bing Maps imagery) but shows a watermark. For clean visuals:

1. Get a free token at https://ion.cesium.com/tokens
2. Add to the sniffer's template before the globe script:

```html
<script>window.INTERCEPT_CESIUM_TOKEN = 'YOUR_TOKEN_HERE';</script>
<script src="/static/js/iridium-globe.js"></script>
```

---

### Phase 5: Doppler Position → Globe Observer (Bonus Integration)

The sniffer's `doppler_pos.c` computes receiver location from IRA frames. Feed this back to the globe as the observer position for visibility calculations.

**In `app.py` — listen for position solutions via Socket.IO:**

The sniffer already outputs position solutions to stderr when `--position` is enabled. Parse them in `stderr_reader()`:

```python
POSITION_RE = re.compile(
    r'POS:\s+([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+HDOP:\s*([\d.]+)'
)

def stderr_reader(proc):
    """Read stderr (stats + verbose + position) and push to websocket."""
    global stats
    try:
        for line in iter(proc.stderr.readline, ""):
            if not line:
                break
            line_str = line.strip()
            if not line_str:
                continue

            # Check for position solution
            pos_m = POSITION_RE.search(line_str)
            if pos_m:
                pos = {
                    "lat": float(pos_m.group(1)),
                    "lon": float(pos_m.group(2)),
                    "alt": float(pos_m.group(3)),
                    "hdop": float(pos_m.group(4)),
                }
                _save_observer(pos)  # Auto-update observer file
                socketio.emit("position", pos)
                continue

            parsed = parse_stats_line(line_str)
            if parsed:
                stats.update(parsed)
                socketio.emit("stats", stats)
            else:
                socketio.emit("log", {"data": line_str})
    except Exception:
        pass
```

**In the frontend — update globe observer when position is solved:**

```javascript
socket.on('position', function(pos) {
    console.log('Doppler position:', pos);
    // Save to server
    fetch('/api/observer', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(pos),
    });
    // Globe will pick up new observer on next resetView()
});
```

---

## File Inventory

### Files to Create

| File | Source | Size | Purpose |
|------|--------|------|---------|
| `gui/static/js/iridium-globe.js` | Copy from INTERCEPT | ~866 lines | 3D Globe rendering module |
| `gui/observer_location.json` | Auto-created at runtime | — | Persisted observer lat/lon |

### Files to Modify

| File | Changes | Scope |
|------|---------|-------|
| `gui/app.py` | Add TLE proxy, observer endpoint, static folder config | ~80 lines added |
| `gui/templates/index.html` | Add globe tab + container + CSS + JS | ~100 lines added |

### External CDN Dependencies (loaded on demand)

| Library | Version | Size | URL |
|---------|---------|------|-----|
| CesiumJS | 1.139.1 | ~4 MB | `cesium.com/downloads/cesiumjs/releases/1.139.1/Build/Cesium/Cesium.js` |
| satellite.js | 5.0.0 | ~40 KB | `unpkg.com/satellite.js@5.0.0/dist/satellite.min.js` |

No CDN dependencies are loaded until the user clicks the 🛰️ 3D Globe tab (lazy loading).

---

## API Endpoint Summary

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| GET | `/api/tles` | Return cached TLE data + observer location | None |
| POST | `/api/tles/refresh` | Force CelesTrak re-fetch (bypass 6h cache) | None |
| GET | `/api/observer` | Get current observer location | None |
| POST | `/api/observer` | Set observer location `{lat, lon, alt, name}` | None |

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  CelesTrak API                                              │
│  celestrak.org/NORAD/elements/gp.php?GROUP=iridium-NEXT     │
└────────────────────────┬────────────────────────────────────┘
                         │ 3-line TLE format (66 satellites)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  gui/app.py — /api/tles                                     │
│  • urllib.request proxy (avoids CORS)                       │
│  • 6-hour in-memory cache                                   │
│  • Returns TLEs + observer location as JSON                 │
└────────────────────────┬────────────────────────────────────┘
                         │ JSON: {tles: [...], observer: {...}}
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  iridium-globe.js — createFromTLEs()                        │
│  • Loads CesiumJS + satellite.js from CDN (one-time)        │
│  • Parses TLEs → satellite.js satrec objects                │
│  • SGP4 propagation → lat/lon/alt for each satellite        │
│  • Computes ground tracks (60 points per orbit)             │
│  • Determines visibility from observer location             │
│  • Creates CesiumJS 3D viewer with satellite entities       │
│  • Starts 30fps animation loop for live tracking            │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Doppler Position Integration (optional)                    │
│  • iridium-sniffer --position decodes IRA frames           │
│  • Doppler solver computes receiver lat/lon/alt             │
│  • Position emitted via Socket.IO → saved as observer       │
│  • Globe resetView() flies to computed position            │
│  • Visibility recalculated for new observer                │
└─────────────────────────────────────────────────────────────┘
```

---

## Testing Checklist

- [ ] `/api/tles` returns valid JSON with `tles` array (66 entries expected)
- [ ] TLE cache expires after 6 hours (verify with `/api/tles` → check `tle_age_min`)
- [ ] `/api/tles/refresh` force-fetches fresh data from CelesTrak
- [ ] `/api/observer` GET/POST round-trips correctly
- [ ] `observer_location.json` file created after first POST
- [ ] Globe tab shows "Click to load" initially, lazy-loads on click
- [ ] CesiumJS + satellite.js load successfully from CDN
- [ ] 66 satellites rendered with correct orbital positions
- [ ] Beam coverage ellipses visible when "Beams" checked
- [ ] Ground track orbits visible when "Orbits" checked
- [ ] ⌂ Reset button flies to observer location (or default if not set)
- [ ] Map style switching works (Satellite/OSM/Dark)
- [ ] 🔄 TLE button refreshes and rebuilds globe
- [ ] No console errors in browser DevTools
- [ ] Works without Cesium Ion token (shows watermark, but functional)
- [ ] Doppler position solutions auto-update observer (when `--position` is active)

---

## Notes

- **No Python packages required** — the backend uses only stdlib (`urllib.request`, `json`, `threading`)
- **No database required** — observer location stored as a simple JSON file
- **Lazy loading** — CesiumJS (~4 MB) is only downloaded when the user first opens the Globe tab
- **Offline fallback** — if CelesTrak is unreachable, the globe won't render (no Keplerian fallback in the sniffer version to keep it simple; can be added later from INTERCEPT's `_compute_iridium_constellation_keplerian()`)
- **The existing DQPSK Constellation tab is unrelated** — it shows demodulation I/Q scatter, not satellite positions
