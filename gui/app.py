"""
iridium-sniffer Mission Control — Flask + Socket.IO backend

Runs iridium-sniffer as a managed subprocess, streams stdout/stderr
to the browser in real-time via WebSocket, and exposes a REST API
for start/stop/configure operations.

All state lives in this process. Nothing is installed system-wide.
"""

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
GUI_DIR = Path(__file__).resolve().parent
PROJECT_DIR = GUI_DIR.parent
BUILD_DIR = PROJECT_DIR / "build"
BINARY = BUILD_DIR / "iridium-sniffer"

app = Flask(__name__, template_folder=str(GUI_DIR / "templates"))
app.config["SECRET_KEY"] = os.urandom(24)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ---------------------------------------------------------------------------
# Process state
# ---------------------------------------------------------------------------
process_lock = threading.Lock()
sniffer_proc = None          # subprocess.Popen or None
sniffer_thread = None        # stdout reader thread
stderr_thread = None         # stderr reader thread
start_time = None
is_running = False

# Stats parsed from stderr status line
stats = {
    "bursts": 0,
    "frames": 0,
    "ok_percent": 0.0,
    "queue_max": 0,
    "dropped": 0,
    "elapsed": 0,
    "raw_line": "",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def find_devices():
    """Run --list and parse available SDR devices."""
    if not BINARY.exists():
        return {"error": f"Binary not found at {BINARY}"}
    try:
        result = subprocess.run(
            [str(BINARY), "--list"],
            capture_output=True, text=True, timeout=10
        )
        lines = (result.stdout + result.stderr).strip().split("\n")
        devices = []
        for line in lines:
            line = line.strip()
            if not line or line.startswith("Available"):
                continue
            devices.append(line)
        return {"devices": devices}
    except subprocess.TimeoutExpired:
        return {"devices": [], "warning": "Device scan timed out"}
    except Exception as e:
        return {"error": str(e)}


def build_command(config):
    """Build the iridium-sniffer command from GUI config dict."""
    cmd = [str(BINARY)]

    # Input validation: reject shell metacharacters in all string fields
    # subprocess.Popen with list args prevents shell injection, but we
    # also reject suspicious characters as defense-in-depth.
    def _safe_str(val, field_name, allow_slashes=False):
        s = str(val).strip()
        forbidden = set(';&|`$(){}!\\\'\"<>\n\r')
        if not allow_slashes:
            forbidden.add('/')
            forbidden.add('\\')
        bad = forbidden & set(s)
        if bad:
            raise ValueError(f"Invalid characters in {field_name}: {bad}")
        return s

    def _safe_path(val, field_name):
        """Allow filesystem paths but reject shell metacharacters."""
        return _safe_str(val, field_name, allow_slashes=True)

    mode = config.get("mode", "live")

    if mode == "file":
        filepath = config.get("file_path", "")
        if not filepath:
            raise ValueError("No IQ file path specified")
        cmd += ["-f", _safe_path(filepath, "file_path")]
        fmt = config.get("file_format", "auto")
        if fmt and fmt != "auto":
            fmt = _safe_str(fmt, "file_format")
            if fmt not in ("cf32", "ci16", "ci8"):
                raise ValueError(f"Invalid file format: {fmt}")
            cmd += ["--format", fmt]
    else:
        iface = config.get("interface", "")
        if not iface:
            raise ValueError("No SDR interface specified")
        cmd += ["-i", _safe_str(iface, "interface", allow_slashes=False)]

    # Frequency & sample rate
    freq = config.get("center_freq")
    if freq:
        cmd += ["-c", str(int(float(freq)))]
    rate = config.get("sample_rate")
    if rate:
        cmd += ["-r", str(int(float(rate)))]

    # Threshold
    threshold = config.get("threshold")
    if threshold:
        cmd += ["-d", str(float(threshold))]

    # Gain (device-specific)
    device_type = config.get("device_type", "soapy")
    if device_type == "hackrf":
        lna = config.get("hackrf_lna")
        if lna is not None:
            cmd += ["--hackrf-lna", str(int(lna))]
        vga = config.get("hackrf_vga")
        if vga is not None:
            cmd += ["--hackrf-vga", str(int(vga))]
        if config.get("hackrf_amp"):
            cmd.append("--hackrf-amp")
    elif device_type == "soapy":
        gain = config.get("soapy_gain")
        if gain is not None:
            cmd += ["--soapy-gain", str(int(gain))]

    # Bias tee
    if config.get("bias_tee"):
        cmd.append("-B")

    # Features
    if config.get("web_map"):
        port = config.get("web_port", 8888)
        cmd.append(f"--web={port}")
    if config.get("acars"):
        cmd.append("--acars")
    if config.get("acars_json"):
        cmd.append("--acars-json")
    if config.get("gsmtap"):
        cmd.append("--gsmtap")
    if config.get("parsed"):
        cmd.append("--parsed")
    if config.get("position"):
        height = config.get("position_height", "")
        if height:
            cmd.append(f"--position={height}")
        else:
            cmd.append("--position")

    # SIMD
    simd = config.get("simd", "auto")
    if simd and simd != "auto":
        cmd += ["--simd", simd]

    # GPU
    if config.get("no_gpu", True):
        cmd.append("--no-gpu")

    # Gardner
    if config.get("no_gardner"):
        cmd.append("--no-gardner")

    # Chase
    chase = config.get("chase")
    if chase and int(chase) > 0:
        cmd.append(f"--chase={int(chase)}")

    # Station ID
    station = config.get("station_id")
    if station:
        cmd += ["--station", _safe_str(station, "station_id")]

    # Verbose
    if config.get("verbose"):
        cmd.append("-v")

    # ZMQ
    if config.get("zmq"):
        endpoint = config.get("zmq_endpoint", "")
        if endpoint:
            cmd.append(f"--zmq={endpoint}")
        else:
            cmd.append("--zmq")

    # Feed
    feed = config.get("feed")
    if feed:
        feed_url = config.get("feed_url", "")
        if feed_url:
            cmd.append(f"--feed={feed_url}")
        else:
            cmd.append("--feed")

    # Save bursts
    bursts_dir = config.get("save_bursts")
    if bursts_dir:
        cmd += ["--save-bursts", _safe_path(bursts_dir, "save_bursts")]

    return cmd


# Stats regex: two formats depending on diagnostic mode
# Legacy gr-iridium format (default):
#   1711234567 | i: 45/s | i_avg: 45/s | q_max:   2 | i_ok: 100% | o:  3/s | ok: 75% | ok: 3/s | ok_avg: 74% | ok:       567 | ok_avg:   2/s | d: 0
STATS_LEGACY_RE = re.compile(
    r"(\d{10})\s*\|\s*(?:i:\s*([\d.]+)/s|srr:\s*[\d.]+%)"
    r"\s*\|\s*i_avg:\s*([\d.]+)/s"
    r"\s*\|\s*q_max:\s*(\d+)"
    r"\s*\|\s*i_ok:\s*([\d.]+)%"
    r"\s*\|\s*o:\s*([\d.]+)/s"
    r"\s*\|\s*ok:\s*([\d.]+)%"
    r"\s*\|\s*ok:\s*([\d.]+)/s"
    r"\s*\|\s*ok_avg:\s*([\d.]+)%"
    r"\s*\|\s*ok:\s*(\d+)"
    r"\s*\|\s*ok_avg:\s*([\d.]+)/s"
    r"\s*\|\s*d:\s*(\d+)"
)
# Diagnostic format:
#   Runtime: 00:01:23  |  Bursts: 1234 detected (45.6/min)  |  Decoded: 567 (ok_avg: 75%)  |  Noise: -71.3 dBFS/Hz  |  Peak: 18.2 dB
STATS_DIAG_RE = re.compile(
    r"Runtime:\s*(\d+:\d+:\d+)\s*\|\s*"
    r"Bursts:\s*(\d+)\s+detected\s+\(([\d.]+)/min\)\s*\|\s*"
    r"Decoded:\s*(\d+)\s+\(ok_avg:\s*([\d.]+)%\)\s*\|\s*"
    r"Noise:\s*([-\d.]+)\s+dBFS/Hz\s*\|\s*"
    r"Peak:\s*([\d.]+)\s+dB"
)


def parse_stats_line(line):
    """Parse stderr stats line (legacy or diagnostic format)."""
    m = STATS_LEGACY_RE.search(line)
    if m:
        return {
            "elapsed": int(m.group(1)),
            "input_rate": float(m.group(2) or 0),
            "input_rate_avg": float(m.group(3)),
            "queue_max": int(m.group(4)),
            "input_ok_pct": float(m.group(5)),
            "output_rate": float(m.group(6)),
            "ok_percent": float(m.group(7)),
            "ok_rate": float(m.group(8)),
            "ok_avg": float(m.group(9)),
            "frames": int(m.group(10)),
            "ok_rate_avg": float(m.group(11)),
            "dropped": int(m.group(12)),
            "bursts": int(m.group(10)),  # ok total as proxy
            "raw_line": line.strip(),
        }
    m = STATS_DIAG_RE.search(line)
    if m:
        parts = m.group(1).split(":")
        elapsed_s = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        return {
            "elapsed": elapsed_s,
            "input_rate": float(m.group(3)),  # bursts/min → approx /s
            "input_rate_avg": float(m.group(3)),
            "bursts": int(m.group(2)),
            "frames": int(m.group(4)),
            "ok_avg": float(m.group(5)),
            "ok_percent": float(m.group(5)),
            "noise_floor": float(m.group(6)),
            "peak_signal": float(m.group(7)),
            "queue_max": 0,
            "dropped": 0,
            "raw_line": line.strip(),
        }
    return None


RAW_RE = re.compile(
    r'RAW:\s+(\S+)\s+([\d.]+)\s+(\d+)\s+'
    r'N:([\d.]+)([+-][\d.]+)\s+I:(\d+)\s+(\d+)%\s+([\d.]+)\s+(\d+)\s+([01]+)'
)


def stdout_reader(proc):
    """Read stdout (RAW lines) and push to websocket."""
    global is_running
    try:
        for line in iter(proc.stdout.readline, ""):
            if not line:
                break
            line = line.strip()
            if line:
                socketio.emit("raw_line", {"data": line})
                # Parse RAW lines into structured frame data for visualizations
                m = RAW_RE.match(line)
                if m:
                    symbols = int(m.group(9))
                    bits = m.group(10)
                    # Classify frame type by symbol count
                    if symbols <= 64:
                        ftype = "IRA"
                    elif symbols >= 200:
                        ftype = "IBC"
                    else:
                        ftype = "IDA"
                    socketio.emit("frame", {
                        "iface": m.group(1),
                        "time_ms": float(m.group(2)),
                        "freq_hz": int(m.group(3)),
                        "snr_db": float(m.group(4)),
                        "noise_dbfs": float(m.group(5)),
                        "burst_id": int(m.group(6)),
                        "confidence": int(m.group(7)),
                        "level": float(m.group(8)),
                        "symbols": symbols,
                        "type": ftype,
                        "bits_preview": bits[:32] if len(bits) > 32 else bits,
                    })
                # Parse IDA lines for sub-type info
                elif line.startswith("IDA:"):
                    ida_type = "IDA"
                    if "maint" in line:
                        ida_type = "IDA-maint"
                    elif "acchl" in line:
                        ida_type = "IDA-acchl"
                    elif "hndof" in line:
                        ida_type = "IDA-hndof"
                    socketio.emit("ida_frame", {"data": line, "type": ida_type})
    except Exception:
        pass
    finally:
        is_running = False
        socketio.emit("status", {"running": False, "message": "Process ended"})


def stderr_reader(proc):
    """Read stderr (stats + verbose) and push to websocket."""
    global stats
    try:
        for line in iter(proc.stderr.readline, ""):
            if not line:
                break
            line_str = line.strip()
            if not line_str:
                continue

            parsed = parse_stats_line(line_str)
            if parsed:
                stats.update(parsed)
                socketio.emit("stats", stats)
            else:
                socketio.emit("log", {"data": line_str})
    except Exception:
        pass


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    return jsonify({
        "running": is_running,
        "binary_exists": BINARY.exists(),
        "binary_path": str(BINARY),
        "stats": stats,
        "start_time": start_time,
        "uptime": int(time.time() - start_time) if start_time and is_running else 0,
    })


@app.route("/api/devices")
def api_devices():
    return jsonify(find_devices())


@app.route("/api/start", methods=["POST"])
def api_start():
    global sniffer_proc, sniffer_thread, stderr_thread, start_time, is_running, stats

    if is_running:
        return jsonify({"error": "Already running"}), 409

    config = request.get_json(force=True)

    try:
        cmd = build_command(config)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    # Reset stats
    stats = {
        "bursts": 0, "frames": 0, "ok_percent": 0.0,
        "queue_max": 0, "dropped": 0, "elapsed": 0, "raw_line": "",
    }

    try:
        sniffer_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            preexec_fn=os.setsid,
        )
    except FileNotFoundError:
        return jsonify({"error": f"Binary not found: {BINARY}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    is_running = True
    start_time = time.time()

    sniffer_thread = threading.Thread(target=stdout_reader, args=(sniffer_proc,), daemon=True)
    sniffer_thread.start()

    stderr_thread = threading.Thread(target=stderr_reader, args=(sniffer_proc,), daemon=True)
    stderr_thread.start()

    socketio.emit("status", {"running": True, "command": " ".join(cmd)})

    return jsonify({"ok": True, "command": " ".join(cmd), "pid": sniffer_proc.pid})


@app.route("/api/stop", methods=["POST"])
def api_stop():
    global sniffer_proc, is_running

    if not is_running or sniffer_proc is None:
        return jsonify({"error": "Not running"}), 409

    try:
        os.killpg(os.getpgid(sniffer_proc.pid), signal.SIGTERM)
    except ProcessLookupError:
        pass

    sniffer_proc.wait(timeout=5)
    is_running = False
    sniffer_proc = None
    start_time_val = None

    socketio.emit("status", {"running": False, "message": "Stopped by user"})

    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# WebSocket events
# ---------------------------------------------------------------------------

@socketio.on("connect")
def ws_connect():
    socketio.emit("status", {
        "running": is_running,
        "stats": stats,
    })


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    print(f"\n  iridium-sniffer Mission Control — NXC2 Edition")
    print(f"  ================================================")
    print(f"  Forked from: https://github.com/alphafox02/iridium-sniffer")
    print(f"  Open in browser: http://localhost:{port}")
    print(f"  Binary: {BINARY}")
    print(f"  Binary exists: {BINARY.exists()}")
    print()
    socketio.run(app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True)
