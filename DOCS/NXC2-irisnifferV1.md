# iridium-sniffer — Technical Analysis

> Analysis date: March 20, 2026  
> Codebase version: iridium-sniffer-master  
> Analyst: GitHub Copilot (Claude Sonnet 4.6)

---

## Table of Contents

1. [Overview](#overview)
2. [Signal Processing Pipeline](#signal-processing-pipeline)
3. [Threading Model](#threading-model)
4. [Stage-by-Stage Data Flow](#stage-by-stage-data-flow)
5. [Key Data Structures](#key-data-structures)
6. [Component Reference](#component-reference)
7. [SIMD Acceleration](#simd-acceleration)
8. [GPU Acceleration](#gpu-acceleration)
9. [Build System and Dependencies](#build-system-and-dependencies)
10. [Notable Design Patterns](#notable-design-patterns)
11. [SDR Backend Abstraction](#sdr-backend-abstraction)
12. [Optional Features](#optional-features)
13. [Performance Benchmarks](#performance-benchmarks)
14. [Output Format](#output-format)
15. [File Inventory](#file-inventory)
16. [Mission Control GUI Reference](#mission-control-gui-reference)

---

## Overview

iridium-sniffer is a standalone replacement for [gr-iridium](https://github.com/muccc/gr-iridium) written entirely in C. It eliminates the GNU Radio dependency while producing fully compatible [iridium-toolkit](https://github.com/muccc/iridium-toolkit) RAW output on stdout. The application implements the full Iridium L-band burst detection, downmix, and DQPSK demodulation pipeline from raw SDR IQ samples to decoded frames.

**Primary goals:**
- Drop-in gr-iridium replacement — identical RAW output format
- Lighter weight — no GNU Radio, no Python runtime in the critical path
- Embedded deployment — runs on Raspberry Pi 5 in CPU-only mode
- Feature-additive — built-in ACARS/SBD decoding, Wireshark integration, web map, Doppler positioning

**Key capabilities:**
- Full burst detection, downmix, DQPSK demodulation pipeline
- Direct iridium-toolkit RAW output (compatible with `iridium-parser.py`, `reassembler.py`)
- Built-in ACARS/SBD decoding (no Python pipeline needed)
- Native GSMTAP/LAPDm output to Wireshark via UDP
- Built-in Leaflet.js web map with real-time satellite and ring alert visualization
- Doppler-based receiver positioning from decoded satellite signals
- Three-tier SIMD dispatch: AVX2+FMA / SSE4.2 / Scalar
- GPU-accelerated burst detection FFT via OpenCL or Vulkan (runtime plugin)
- ZMQ PUB/SUB output for multi-consumer iridium-toolkit compatibility
- ZMQ SUB and VITA 49/VRT network IQ input for distributed setups
- SDR support: HackRF, BladeRF, USRP (UHD), SDRplay, SoapySDR, plus file input

---

## Signal Processing Pipeline

```
SDR / IQ file  (ci8 / ci16 / cf32)
        │
        ▼  [samples_queue — 4096 slots]
┌──────────────────────────────────┐
│  Burst Detector  (1 thread)      │
│  8192-pt FFT sliding window      │
│  Adaptive noise floor (512-frame)│
│  Threshold + hysteresis SM       │
└──────────────────────────────────┘
        │
        ▼  [burst_queue — 2048 slots]
┌──────────────────────────────────┐
│  Downmix Workers  (4 threads)    │  ← parallel, 1 burst per thread
│  Coarse CFO → LPF → 40:1 decim  │
│  Fine CFO → RRC filter           │
│  Sync-word correlation DL+UL     │
│  Phase align → frame extract     │
└──────────────────────────────────┘
        │
        ▼  [frame_queue — 512 slots]
┌──────────────────────────────────┐
│  QPSK Demod + Output  (1 thread) │  ← serialized for stdout
│  Gardner timing recovery         │
│  First-order PLL → hard DQPSK   │
│  Unique word verify → bits       │
│  RAW formatter → stdout          │
└──────────────────────────────────┘
        │
        ▼  [output_queue — 1024 slots]  (optional slow path)
┌──────────────────────────────────┐
│  Frame Output  (1 thread)        │
│  IDA decode → ACARS/SBD          │
│  Web map update (SSE push)       │
│  Doppler solver                  │
│  GSMTAP UDP sender               │
└──────────────────────────────────┘
```

---

## Threading Model

| Thread | Count | Synchronization | Role |
|---|---|---|---|
| Burst detector | 1 | Reads `samples_queue`, writes `burst_queue` | Sequential FFT state machine |
| Downmix workers | 4 | Reads `burst_queue`, writes `frame_queue` | Parallel per-burst DSP |
| Demod + output | 1 | Reads `frame_queue`, writes `output_queue` | Serialized demod + stdout |
| Frame output | 1 | Reads `output_queue` | Slow path (web/ACARS/Doppler) |
| Stats | 1 | Atomic reads of shared counters | 1 Hz stderr metrics |
| SDR driver | 1+ | Writes `samples_queue` | Device-specific |
| Web HTTP server | 1 | `web_map` mutex | If `--web` |

**Why the detector is single-threaded:** The FFT state machine maintains sequential per-bin baseline history, noise floor accumulators, and active burst state. Parallelizing this would require complex synchronization with little benefit since FFTW already exploits SIMD internally.

**Why 4 downmix workers:** Each burst is fully independent. Downmix is the most CPU-intensive stage (multiple FFTs per burst). Four threads is the empirical sweet spot for throughput without excessive contention on `frame_queue`.

**Why demod+output is single-threaded:** POSIX stdout requires serialization. Demodulation is fast enough that a single thread keeps up at all realistic burst rates.

### Queue Primitives

All inter-stage queues use a custom **fair FIFO blocking queue** (`blocking_queue.h`, 556 lines). Key properties:

- **Fair lock** (`fair_lock.h`, 292 lines): Reader-writer fairness via ticket lock, prevents starvation
- **Weak (non-blocking) operations** for fast rejection when full
- Capacity: `samples_queue` 4096, `burst_queue` 2048, `frame_queue` 512, `output_queue` 1024

Stats counters use `atomic_ulong` for lock-free increments across threads.

---

## Stage-by-Stage Data Flow

### Stage 1: Burst Detection (`burst_detect.c`, 1024 lines)

**Input:** Raw IQ pairs at SDR sample rate (typically 10 MHz)

**Processing:**
1. **Format conversion** (SIMD): `int8 → float32`, or pass-through for `cf32`
2. **Windowing**: Blackman window applied per FFT frame (1/0.42 normalization preserves SNR)
3. **FFT**: 8192-point at 10 MHz ≈ 0.8 ms window, 1 ms frame stride
4. **FFT shift + magnitude²**: `fftshift` + `|X|²` (SIMD)
5. **Adaptive noise floor**: 512-frame circular history, running sum per bin, giving a weighted moving average baseline
6. **Relative magnitude**: `|X|² / baseline`
7. **Peak detection**: Threshold (default 16 dB), DC notch (±3 bins), burst masking to prevent double-detection
8. **Burst state machine**: Hysteresis, max-hold, pre-burst guard (16384 samples), post-burst tail (160,000 samples)
9. **Ringbuffer extraction**: 1.25× max burst length circular buffer for zero-copy burst extraction

**Output:** Complete burst as a contiguous IQ block with metadata (`burst_data_t`)

### Stage 2: Burst Downmix (`burst_downmix.c`, 836 lines)

**Input:** Complete burst IQ block (100+ ms typical at 10 MHz)

**Processing:**
1. **Coarse CFO correction**: Rotate by `f_sr × (bin - center_bin) / FFT_size`
2. **Anti-alias LPF + decimation**: 200-tap LPF (Nyquist 100 kHz, 40 kHz transition), 10 MHz → 250 kHz (1/40 ratio)
3. **Noise-limiting LPF**: 25-tap at 20 kHz cutoff applied zero-phase (half-filter flange)
4. **Burst start detection**: Box-filter magnitude smoothing (~2 sps), 45% of peak threshold, backtrack to preamble
5. **Fine CFO estimation**:
   - Square the signal (removes BPSK/QPSK modulation, isolates 2× CFO tone)
   - 256-point FFT with 16× frequency oversampling
   - Quadratic interpolation for sub-bin precision
   - Normalize: `f_cfo_fine / (FFT_size × 2) × f_sr`
6. **Fine CFO correction**: Rotate by `-2π × center_offset`
7. **RRC matched filter**: 51-tap Root-Raised-Cosine (α=0.4), centered convolution
8. **Sync word correlation** (DL and UL in parallel):
   - Pre-computed templates: DL = 16-symbol preamble + 12-symbol UW; UL = 32 + 12
   - Pulse-shaped with RC filter (51-tap), reversed + conjugated for matched filter
   - Padded to FFT size, correlated via FFT→multiply→IFFT
   - Find peaks with quadratic interpolation; select best direction
9. **Phase alignment**: Rotate by `conj(correlation_peak_phase)`
10. **Frame extraction**: 131–191 samples (DL/IBC) or 80–444 (UL/IRA simplex) at unique word

**Output:** Downmixed frame at 250 kHz / 10 sps (`downmix_frame_t`)

### Stage 3: QPSK Demodulation (`qpsk_demod.c`, 538 lines)

**Input:** Downmixed frame at ~250 kHz, 10 samples/symbol

**Processing:**
1. **Timing recovery** (Gardner TED, enabled by default):
   - Cubic spline interpolation between samples
   - TED error: `Re[(s_prev - s_curr) × conj(s_mid)]`
   - PI loop: Kp=0.02, Ki=0.0002
   - Decimates 10 sps → 1 sps with sub-sample precision
2. **Simple decimation** (fallback, `--no-gardner`): Stride by 10
3. **First-order PLL** (α=0.2):
   - Hard-decision of nearest QPSK constellation point
   - Phase error feedback: `arg(decision / received)`
   - Normalization per symbol to prevent magnitude drift
4. **Hard-decision QPSK**: Map to {0,1,2,3}
5. **Unique word verification**:
   - Hard check: Hamming distance ≤ 2 for DL or UL pattern
   - Soft rescue: Angular distance to ideal constellation ≤ 3.0 (normalized), tried if hard check fails
6. **DQPSK differential decode**: `d[i] = (s[i] - s[i-1]) mod 4` → dqpsk_map[d]
7. **Symbol-to-bits**: QPSK → 2 bits/symbol, MSB first
8. **Confidence**: Fraction of symbols within ±22° of ideal constellation point
9. **Per-bit LLR** (if `--chase`): `|Re/Im(PLL_phase)| × scale` for soft-decision BCH

**Output:** RAW frame with 179 symbols / 358 bits + confidence + metadata

### Stage 4: Frame Output (`frame_output.c`, 362 lines)

Formats and writes the iridium-toolkit RAW line to stdout:

```
RAW: i-10-t1 0000442.4080 1624960925 N:10.77-71.83 I:00000003560  50% 0.11738 179 001100011011...
      ──┬───  ─────┬─────  ────┬────   ──┬── ──┬───   ──────┬────  ─┬─  ───┬──  ─┬─  bits...
        │          │           │         │     │              │       │      │     │
     file_info  time_ms    freq_hz    mag_dB  noise_dBFS    burst_id conf  level syms
```

Optional ZMQ PUB publishes the same line to `tcp://*:7006` (default) for multi-consumer setups.

---

## Key Data Structures

| Structure | Approx Size | Lifecycle |
|---|---|---|
| `burst_data_t` | 1–10 MB | Created by detector per burst; freed after downmix |
| `downmix_frame_t` | ~100 KB | Created by downmix worker; freed by demod |
| `demod_frame_t` | ~50 KB | Created by demod; freed after output |
| `ida_burst_t` | ~1 KB | Created by demod; freed after IDA reassembly |
| `burst_detector_t` | ~50 MB | Global singleton; includes 16 MB baseline history |
| `burst_downmix_t` | ~20 MB | 4 copies (one per worker); holds all FFTW plans + filter state |

**Ringbuffer** (inside `burst_detector_t`): 1.25× max burst length, circular write pointer, sample-level indexing. Avoids per-burst heap allocation in the hot path.

**Baseline history** (inside `burst_detector_t`): `512 × 8192 × 4` bytes ≈ 16 MB. Running sum per bin across 512 FFT frames for the adaptive noise floor.

**FFTW plans** (inside `burst_downmix_t`): CFO (256-point × 16 oversampling), correlation (8192-point × 2 directions). All created with `FFTW_MEASURE` under `fftw_planner_mutex`. Per-burst planning is a one-time cost persisted via FFTW wisdom.

---

## Component Reference

| File | Lines | Responsibility |
|---|---|---|
| `main.c` | 1122 | Thread creation, queue wiring, FFTW wisdom load/save, shutdown |
| `options.c` | 691 | Full CLI parsing, file format auto-detection |
| `burst_detect.c/.h` | 1024 | FFT burst detector, adaptive noise floor, burst state machine |
| `burst_downmix.c/.h` | 836 | Per-burst CFO / decimate / correlate / extract pipeline |
| `qpsk_demod.c/.h` | 538 | Gardner TED, first-order PLL, DQPSK, UW verification |
| `frame_decode.c/.h` | 564 | IRA/IBC BCH de-interleave, geolocation decode, permutation table |
| `frame_output.c/.h` | 362 | RAW format printer, ZMQ PUB |
| `ida_decode.c/.h` | 751 | LCW extraction, payload BCH(31,20), CRC-CCITT, 16-slot reassembly |
| `sbd_acars.c/.h` | 1488 | SBD packet extraction, ACARS field decode, libacars-2 ARINC-622 |
| `web_map.c/.h` | 1185 | Embedded HTTP server, SSE stream, Leaflet.js map HTML |
| `doppler_pos.c/.h` | 1339 | IWLS Doppler position solver, height aiding, spatial clustering |
| `gsmtap.c/.h` | 103 | GSMTAP/LAPDm UDP frame builder for Wireshark |
| `vita49.c/.h` | 423 | VITA 49/VRT UDP IQ receiver, sequence gap detection |
| `simd_kernels.h` | — | SIMD function pointer dispatch table |
| `simd_generic.c` | 223 | Scalar fallback kernels |
| `simd_sse42.c` | 372 | SSE4.2 128-bit kernels (`-msse4.2`) |
| `simd_avx2.c` | 388 | AVX2+FMA 256-bit kernels (`-mavx2 -mfma`) |
| `fir_filter.c/.h` | 193 | FIR convolution (LPF, RRC, RC coefficient generation) |
| `window_func.c/.h` | 24 | Blackman window generation |
| `blocking_queue.h` | 556 | Fair FIFO blocking queue |
| `fair_lock.h` | 292 | Ticket-based reader-writer fairness |
| `fftw_lock.h` | 34 | FFTW planner serialization mutex |
| `rotator.h` | — | Complex frequency rotator (inline) |
| `net_util.h` | — | UDP/TCP socket helpers (inline) |
| `pthread_barrier.h` | — | POSIX barrier polyfill for macOS |
| `wgs84.h` | — | WGS-84 Earth model constants |
| `iridium.h` | — | Global constants, frame type enums |
| `sdr.h` | — | SDR backend interface definition |
| `hackrf.c/.h` | — | HackRF One backend |
| `bladerf.c/.h` | — | BladeRF backend |
| `usrp.c/.h` | — | USRP/UHD backend |
| `sdrplay.c/.h` | — | SDRplay native API backend |
| `soapysdr.c/.h` | — | SoapySDR abstraction backend |
| `doppler_pos.c/.h` | 1339 | IWLS solver |
| `opencl/burst_fft.c/.h` | — | OpenCL FFT plugin (compiled as `.so`) |
| `vulkan/burst_fft.c` | — | Vulkan FFT plugin (compiled as `.so`) |
| `vkfft/fft.h`, `vkFFT.h` | — | VkFFT header-only GPU FFT library (MIT) |

---

## SIMD Acceleration

Three tiers are compiled into the single binary. The appropriate tier is selected once at startup via `__builtin_cpu_supports` (CPUID) and stored as global function pointers, avoiding per-sample branching.

| Tier | ISA Flags | Width | Speedup vs Scalar |
|---|---|---|---|
| AVX2+FMA | `-mavx2 -mfma` | 256-bit | ~1.9× |
| SSE4.2 | `-msse4.2` | 128-bit | ~1.5× |
| Scalar | (none) | 32-bit | baseline |

**Kernels accelerated:**
- `int8 → float32` sample conversion
- FFT shift and magnitude-squared computation
- Noise floor accumulation
- Complex multiply-accumulate (FIR convolution inner loop)

**ARM:** Only the scalar tier is compiled in. NEON is not implemented. Pre-generating FFTW wisdom is essential on ARM to avoid 30–60 s startup delay while FFTW benchmarks plan variants.

---

## GPU Acceleration

GPU support is compiled as a runtime plugin (`libiridium-sniffer-gpu.so`) loaded via `dlopen`. The main binary operates normally on systems without GPU support or when `--no-gpu` is specified.

### Backends

| Backend | API | Platform | Notes |
|---|---|---|---|
| OpenCL | OpenCL 1.2+ | NVIDIA, AMD, Intel | Default when available |
| Vulkan | Vulkan 1.2+ | Modern GPUs, Pi5 | Pi5 VideoCore VII passes validation but cannot sustain batch FFT throughput |

### How It Works

1. `dlopen` tries `./libiridium-sniffer-gpu.so` then the system library path
2. GPU context is created inside `burst_detector_create()`, batch size = 16 FFT frames
3. CPU feeds windowed FFT frames into the GPU batch buffer (`2 × fft_size` floats per frame)
4. When the batch is full (or end of stream), GPU processes all frames in parallel
5. GPU returns magnitude-squared array; CPU runs the burst state machine (peak detection, masking) on the result
6. A correctness validation test runs at startup with a known FFT input; falls back to CPU on failure

### GPU vs CPU

GPU acceleration benefits continuous live capture on desktop/laptop systems the most. For short IQ file processing, the batch dispatch overhead dominates and CPU FFTW is faster. The crossover point is roughly files longer than 60 seconds.

---

## Build System and Dependencies

**CMake 3.9+** — Feature detection-based modular configuration.

### Required

| Library | Package (Ubuntu/Debian) | Purpose |
|---|---|---|
| FFTW3 (float) | `libfftw3-dev` | FFT backbone |
| pthreads | (POSIX) | Threading |
| libm | (system) | Math |

### Optional SDR Backends

| Library | Package | SDR |
|---|---|---|
| libhackrf | `libhackrf-dev` | HackRF One |
| libbladeRF | `libbladerf-dev` | BladeRF |
| UHD | `libuhd-dev` | USRP B200/B210/N200/X300 |
| SoapySDR | `libsoapysdr-dev` | RTL-SDR, Airspy, LimeSDR, etc. |
| SDRplay API 3.x | (sdrplay.com) | RSP1/RSP2/RSPdx |

### Optional Features

| Library | Package | Enables |
|---|---|---|
| libzmq3 | `libzmq3-dev` | `--zmq` PUB/SUB fan-out and `--zmq-sub` input |
| libacars-2 | `libacars-dev` | ARINC-622, ADS-C, CPDLC decoding in `--acars` |
| OpenCL | `ocl-icd-opencl-dev` | GPU burst detection |
| Vulkan + glslang | (varies) | Alternative GPU backend |

### CMake Build Variants

```bash
cmake ..                          # Auto-detect all features
cmake .. -DUSE_OPENCL=ON          # Force OpenCL GPU
cmake .. -DUSE_VULKAN=ON -DUSE_OPENCL=OFF  # Force Vulkan GPU
cmake .. -DUSE_OPENCL=OFF         # CPU only (no GPU)
cmake .. -DCMAKE_BUILD_TYPE=Debug # Debug + AddressSanitizer
```

### Build Output

- `iridium-sniffer` — Main binary
- `libiridium-sniffer-gpu.so` — GPU plugin (if GPU enabled); loaded at runtime

---

## Notable Design Patterns

### 1. Ringbuffer for Zero-Copy Burst Extraction

The burst detector maintains a circular IQ buffer of 1.25× the maximum expected burst length. Bursts are extracted by index range, avoiding per-burst `malloc`. Edge cases (wrap-around) are handled at extraction time.

### 2. Three-Tier SIMD with Function Pointers

ISA capability is checked once at startup via CPUID. Global function pointers are set to the best available implementation. No per-sample branching; call overhead is one pointer dereference.

### 3. Dual Unique Word Direction Check

The downmix stage correlates for both downlink (DL) and uplink (UL) sync patterns simultaneously. The demod stage also independently tries both UW directions. This dual-check recovers frames where the downmix stage guesses the wrong direction.

### 4. Soft Unique Word Rescue

If the Hamming distance check on the unique word fails (>2 bit errors), a secondary check measures angular distance to the ideal QPSK constellation points. This rescues approximately 3 additional frames per 60 second recording with no cost on the normal path.

### 5. FFTW Wisdom Persistence

FFTW plans are created with `FFTW_MEASURE` (benchmarks multiple FFT algorithms at plan creation time). Plans are saved to `~/.iridium-sniffer-fftw-wisdom` on shutdown and loaded on startup. This eliminates the 30–60 s delay on ARM systems after the first run. A `fftw_planner_mutex` serializes all plan creation/destruction calls across threads (FFTW planner is not thread-safe).

### 6. Output Stage Decoupling

The demod thread writes RAW to stdout immediately (hot path). All slow work — web map SSE updates, ACARS text decode, Doppler solver, GSMTAP UDP — is dispatched through `output_queue` to a dedicated frame output thread. This ensures the demod thread never blocks on I/O.

### 7. GPU as a Runtime Plugin

`libiridium-sniffer-gpu.so` is loaded via `dlopen` at startup. If the file is missing, GPU loading fails silently and FFTW is used. This avoids linking GPU libraries into the main binary, keeping it deployable on systems without GPU drivers.

### 8. Multi-Burst IDA Reassembly (16 Slots)

IDA frames are multi-burst: a single logical message spans multiple RF bursts. The IDA decoder maintains 16 concurrent reassembly slots, matching bursts by frequency, time proximity, and sequence number. BCH(31,20) with the poly=3545 polynomial corrects up to 2 bit errors per 31-bit block.

### 9. Dynamic Array Growth

Peak arrays, burst lists, and similar structures start at capacity 64 and double on resize. `realloc` is called only when capacity is exhausted, amortizing allocation cost in the tight detection loop.

### 10. Blocking Queue with Weak Operations

The fair blocking queue supports both blocking and non-blocking (weak) push/pop. Non-blocking operations allow the detector to discard bursts when workers are saturated rather than stalling, preventing unbounded queue growth during high-burst-rate periods.

---

## SDR Backend Abstraction

All SDR backends implement the interface defined in `sdr.h`. The `main.c` code selects the appropriate backend at startup based on the `-i` argument prefix:

| Prefix | Backend | File |
|---|---|---|
| `hackrf-*` | libhackrf | `hackrf.c` |
| `bladerf*` | libbladeRF | `bladerf.c` |
| `usrp-*` | UHD | `usrp.c` |
| `sdrplay-*` | SDRplay native API | `sdrplay.c` |
| `soapy-*` or `soapy:*` | SoapySDR | `soapysdr.c` |

Each backend handles:
- Device enumeration (`--list`)
- Center frequency and sample rate configuration
- Gain configuration (device-specific flags)
- Bias tee / RF amplifier control
- Clock and time source selection (`--clock-source`, `--time-source`)
- Streaming to `samples_queue`

### Network IQ Inputs

Two additional input sources bypass physical SDRs:

| Source | Flag | Protocol |
|---|---|---|
| ZMQ SUB | `--zmq-sub[=ENDPOINT]` | ZMQ SUB socket, any ZMQ PUB publisher (e.g. GNU Radio) |
| VITA 49/VRT | `--vita49[=IP:PORT]` | UDP VRT signal data packets, parser in `vita49.c` |

---

## Optional Features

### Web Map (`--web`)

- Embedded HTTP server (no external dependencies)
- Server-Sent Events (SSE) at 1 Hz for real-time browser updates
- Leaflet.js + OpenStreetMap tiles (loaded from CDN)
- Displays: IRA beam footprints, MT positions, aircraft positions (with `--acars`), paging events, receiver position (with `--position`)
- API endpoints: `GET /` (HTML), `GET /api/events` (SSE), `GET /api/state` (JSON snapshot)

### Doppler Positioning (`--position[=HEIGHT_M]`)

- Iterated Weighted Least Squares (IWLS) solver
- Runs every 10 seconds; requires ≥5 measurements from ≥2 satellites
- Height aiding significantly improves horizontal accuracy
- 3-sigma outlier rejection; spatial clustering to filter corrupted IRA positions
- Reference: Z. Tan et al., IEEE Access, 2019

### GSMTAP (`--gsmtap[=HOST:PORT]`)

- Decodes IDA frames as LAPDm, encapsulates in GSMTAP header
- Sends UDP datagrams to Wireshark (default: `127.0.0.1:4729`)
- Replaces the `iridium-parser.py -m gsmtap` Python pipeline

### ACARS/SBD (`--acars`, `--acars-json`, `--acars-udp`, `--feed`)

- `--acars`: Human-readable text to stdout
- `--acars-json`: JSON to stdout in dumpvdl2/dumphfdl envelope format (`"iridium"` key)
- `--acars-udp=HOST:PORT`: JSON via UDP (repeatable, max 4 destinations)
- `--feed[=PROTO://HOST:PORT]`: iridium-toolkit JSON format for acarshub/airframes.io (repeatable, max 4)

With libacars-2: ARINC-622 application payloads (ADS-C, CPDLC, OHMA, MIAM) are fully decoded.  
Without libacars-2: Basic ACARS field extraction still works.

### ZMQ PUB (`--zmq`)

- Publishes RAW lines on `tcp://*:7006` (default)
- Non-blocking: messages dropped silently when no subscribers are connected
- Enables multiple simultaneous iridium-toolkit consumers
- Requires libzmq (`libzmq3-dev`)

### Parsed IDA Output (`--parsed`)

- Decodes IDA frames internally and outputs `IDA:` lines to stdout
- Designed to pipe directly to `reassembler.py -m acars` without `iridium-parser.py`
- Only IDA frames decoded; other types still appear as `RAW:` lines

### Chase Soft-Decision BCH (`--chase=N`)

- Per-bit amplitude LLRs computed from PLL phase at each symbol
- N controls the number of bit-flip combinations tried (1–7 bits; recommended: `--chase=5` = 31 combos)
- IDA frames only (IRA/IBC Chase is disabled)
- Off by default; experimental

### Burst IQ Capture (`--save-bursts=DIR`)

- Saves `<timestamp>_<freq>_<id>_<direction>.cf32` + `.meta` per decoded burst
- IQ at 250 kHz / 10 sps, RRC-filtered, aligned to unique word
- Use cases: RF fingerprinting, demodulator development, regression testing

---

## Performance Benchmarks

### File Processing Speed (60s cf32, i7-11800H)

| Configuration | Wall Time | CPU Time | Realtime Factor |
|---|---|---|---|
| AVX2 + GPU OpenCL | 15.1 s | 23.6 s | 4.0× |
| AVX2 only | 12.0 s | 21.5 s | 5.0× |
| SSE4.2 only | — | — | ~3.5× (est.) |
| Scalar + GPU OpenCL | 16.1 s | 42.6 s | 3.7× |
| Scalar only | 13.0 s | 40.6 s | 4.6× |

### Frame Recovery vs gr-iridium (same 60s file)

**At default 16 dB threshold:**

| Metric | iridium-sniffer | gr-iridium |
|---|---|---|
| Detected bursts | 5,468 | ~3,666 |
| Decoded RAW frames | 3,701 | 2,713 |
| Ok rate | 68% | 74% |

**At matched 18 dB threshold (apples-to-apples):**

| Metric | iridium-sniffer | gr-iridium |
|---|---|---|
| Detected bursts | 3,668 | ~3,666 |
| Decoded RAW frames | 2,737 | 2,713 |
| Ok rate | 75% | 74% |

**Interpretation:** The lower default threshold (16 dB vs gr-iridium's 18 dB) catches more marginal bursts, increasing total frame count by 36% at the cost of a lower ok% figure. The ok% metric measures the fraction of detected bursts that decode — not total frames recovered. What matters operationally is decoded frames per second.

---

## Output Format

### RAW (stdout)

```
RAW: i-10-t1 0000442.4080 1624960925 N:10.77-71.83 I:00000003560  50% 0.11738 179 001100011011...
```

| Field | Example | Description |
|---|---|---|
| file_info | `i-10-t1` | SDR interface identifier |
| time_ms | `0000442.4080` | Burst timestamp in milliseconds |
| freq_hz | `1624960925` | Burst center frequency in Hz |
| N:mag | `10.77` | SNR-like magnitude in dB above noise floor |
| noise | `-71.83` | Noise floor in dBFS/Hz |
| burst_id | `I:00000003560` | Sequential burst counter |
| confidence | `50%` | Fraction of symbols within ±22° of ideal QPSK point |
| level | `0.11738` | Raw burst amplitude (linear scale) |
| symbols | `179` | Number of demodulated symbols |
| bits | `001100011011...` | Demodulated bit string |

### stderr (stats, 1 Hz)

Same format as gr-iridium status output, compatible with existing monitoring scripts.

---

## File Inventory

```
iridium-sniffer-master/
├── main.c                  Entry point, threading skeleton
├── options.c               CLI argument parsing
├── iridium.h               Global constants, frame type enums
├── sdr.h                   SDR backend interface
│
├── burst_detect.c/.h       FFT burst detector
├── burst_downmix.c/.h      Per-burst DSP pipeline
├── qpsk_demod.c/.h         DQPSK demodulator
├── frame_decode.c/.h       IRA/IBC frame decoder
├── frame_output.c/.h       RAW printer / ZMQ PUB
├── ida_decode.c/.h         IDA multi-burst reassembly
│
├── sbd_acars.c/.h          ACARS/SBD higher-layer decode
├── web_map.c/.h            Embedded HTTP server + Leaflet.js
├── doppler_pos.c/.h        Doppler IWLS position solver
├── gsmtap.c/.h             GSMTAP/Wireshark integration
├── vita49.c/.h             VITA 49/VRT UDP input
│
├── fir_filter.c/.h         FIR coefficient generation + convolution
├── window_func.c/.h        Blackman window
├── rotator.h               Complex frequency rotator (inline)
├── net_util.h              UDP/TCP helpers (inline)
├── wgs84.h                 WGS-84 Earth model constants
├── pthread_barrier.h       POSIX barrier polyfill (macOS)
│
├── blocking_queue.h        Fair FIFO blocking queue (556 lines)
├── fair_lock.h             Ticket-based reader-writer lock
├── fftw_lock.h             FFTW planner mutex
│
├── simd_kernels.h          SIMD dispatch table
├── simd_generic.c          Scalar fallback kernels
├── simd_sse42.c            SSE4.2 128-bit kernels
├── simd_avx2.c             AVX2+FMA 256-bit kernels
│
├── hackrf.c/.h             HackRF One backend
├── bladerf.c/.h            BladeRF backend
├── usrp.c/.h               USRP/UHD backend
├── sdrplay.c/.h            SDRplay native API backend
├── soapysdr.c/.h           SoapySDR abstraction backend
│
├── CMakeLists.txt          Build system
├── cmake/
│   ├── Modules/            FindXXX.cmake for all optional libs
│   └── cmake_uninstall.cmake.in
│
├── opencl/
│   └── burst_fft.c/.h      OpenCL GPU plugin source
├── vulkan/
│   └── burst_fft.c         Vulkan GPU plugin source
├── vkfft/
│   ├── fft.h               VkFFT wrapper
│   └── vkFFT.h             VkFFT header-only library (MIT, ~25K lines)
│
├── examples/               Example shell scripts per SDR
│   ├── hackrf.sh
│   ├── bladerf.sh
│   ├── usrp-b2x0.sh
│   ├── rtl-sdr.sh
│   └── airspy-r2.sh
│
├── DOCS/
│   └── NXC2-irisniffer.md  This document
│
├── README.md               User-facing documentation
├── ARCHITECTURE.md         Developer architecture notes
└── LICENSE                 GNU GPL v3.0
```

---

## Mission Control GUI Reference

The Mission Control GUI (`gui/`) is a Flask + Socket.IO single-page application that wraps iridium-sniffer with a real-time browser dashboard. It runs in an isolated Python virtualenv on port 5050 (configurable).

### Launching

```bash
cd gui
bash launch-gui.sh 5050        # creates venv, installs deps, starts on port 5050
# or manually:
source venv/bin/activate
python3 app.py 5050
```

Open: `http://localhost:5050`

---

### Sidebar Controls — Complete Switch Reference

#### Input Source Panel

| Control | Type | Default | Description |
|---|---|---|---|
| **Mode** | Dropdown | `Live SDR Capture` | Switch between live SDR capture and IQ file playback |
| **Device Type** | Dropdown | `HackRF One` | Select SDR backend: HackRF One or RTL-SDR / SoapySDR. Selecting a type auto-fills center frequency and sample rate defaults for that device |
| **Interface** | Text + SCAN | Auto-populated | Device identifier (e.g. `hackrf-000000000000001a`, `soapy-0`). SCAN button auto-detects connected devices on page load |
| **LNA Gain** | Slider | 40 dB | HackRF LNA gain (0–40 dB, 8 dB steps). Maps to `--hackrf-lna` |
| **VGA Gain** | Slider | 20 dB | HackRF VGA gain (0–62 dB, 2 dB steps). Maps to `--hackrf-vga` |
| **RF Amplifier** | Toggle | OFF | HackRF 14 dB RF amplifier. Maps to `--hackrf-amp` |
| **Gain** | Slider | 30 dB | SoapySDR overall gain (0–50 dB). Maps to `--soapy-gain`. Only visible when RTL-SDR/SoapySDR selected |
| **File Path** | Text | — | IQ recording path (only in File mode). Maps to `-f` |
| **Format** | Dropdown | Auto-detect | IQ file sample format: `cf32`, `ci16`, `ci8`, or auto. Maps to `--format` |

#### RF Settings Panel

| Control | Type | Default | Description |
|---|---|---|---|
| **Center Freq (Hz)** | Text | `1622000000` (HackRF) / `1625500000` (SoapySDR) | L-band center frequency. HackRF covers the full 10 MHz Iridium band; RTL-SDR covers a 2.4 MHz slice. Maps to `-c` |
| **Sample Rate (Hz)** | Text | `10000000` (HackRF) / `2400000` (SoapySDR) | ADC sample rate. Maps to `-r` |
| **Threshold (dB)** | Slider | 16 dB | Burst detection threshold above the adaptive noise floor. Lower catches more marginal bursts at the cost of ok%. Range 10–24 dB. Maps to `-d` |
| **Bias Tee** | Toggle | ON | Supplies DC power to an active antenna over the coax. Maps to `-B` |

#### Processing Panel

| Control | Type | Default | Description |
|---|---|---|---|
| **SIMD** | Dropdown | Auto | Force SIMD tier: Auto (best available), AVX2, SSE4.2, or Scalar. Maps to `--simd` |
| **Chase BCH** | Dropdown | Off | Soft-decision BCH error correction. Higher = more bit-flip combos tried (3→7, 5→31, 7→127). IDA frames only. Maps to `--chase=N` |
| **Gardner TED** | Toggle | ON | Gardner timing error detector for symbol recovery. Disabling falls back to simple 10× decimation. When OFF maps to `--no-gardner` |
| **GPU (OpenCL)** | Toggle | OFF | Use GPU for burst detection FFT. Requires `libiridium-sniffer-gpu.so` and OpenCL runtime. When OFF maps to `--no-gpu` |
| **Verbose** | Toggle | OFF | Print verbose diagnostic messages to stderr / System Log tab. Maps to `-v` |

#### Features Panel

| Control | Type | Default | Description |
|---|---|---|---|
| **Web Map** | Toggle | OFF | Launch embedded Leaflet.js web map at `http://localhost:8888`. Shows satellite beam footprints, MT positions, ring alerts. Maps to `--web=PORT` |
| **ACARS Decode** | Toggle | OFF | Decode SBD/ACARS payloads to human-readable text in RAW output. Maps to `--acars` |
| **ACARS JSON** | Toggle | OFF | Emit JSON-formatted ACARS in dumpvdl2/dumphfdl envelope format. Maps to `--acars-json` |
| **GSMTAP → Wireshark** | Toggle | OFF | Send GSMTAP/LAPDm UDP frames to Wireshark on `127.0.0.1:4729`. Maps to `--gsmtap` |
| **Parsed IDA** | Toggle | OFF | Decode IDA frames internally, output `IDA:` lines usable by `reassembler.py` without `iridium-parser.py`. Maps to `--parsed` |
| **Doppler Position** | Toggle | OFF | Estimate receiver position from Doppler shifts. Needs ≥5 measurements from ≥2 satellites. Maps to `--position` |
| **ZMQ PUB** | Toggle | OFF | Publish RAW lines on `tcp://*:7006` for multi-consumer iridium-toolkit setups. Maps to `--zmq` |
| **Station ID** | Text | — | Custom station identifier included in output. Maps to `--station` |

---

### Main Content Area — Tabs

The right-side content area displays a stats bar, a live throughput chart, and five tabbed views:

#### Stats Bar (always visible)

| Metric | Color | Source |
|---|---|---|
| **Bursts** | Cyan | Total detected bursts (from stderr stats) |
| **Frames** | Green | Total decoded RAW frames |
| **Ok Avg** | Orange | Running average of ok% (fraction of bursts that decoded) |
| **Input** | Blue | SDR sample input rate (samples/s) |
| **Q Max** | Purple | Peak downmix queue depth — indicates worker saturation |
| **Dropped** | Red | Bursts dropped due to full queue. Non-zero means CPU can't keep up |

#### Live Chart (always visible)

- **Green line (left axis)**: Frames/second — derived from frame delta between 1 Hz stats ticks
- **Orange line (right axis)**: Ok avg % — rolling decode success rate
- Scrolling 120-second window

#### Tab: RAW Output

Live stream of every RAW line emitted by iridium-sniffer on stdout, exactly as it would appear when running in a terminal. ACARS/SBD lines are highlighted in orange.

#### Tab: System Log

stderr output: 1 Hz stats lines, verbose diagnostics (if `-v`), and GUI system messages (start, stop, errors).

#### Tab: Spectrum

**Live RF spectrum view** showing detected burst activity across the tuned frequency range.

- **X-axis**: Frequency in MHz (derived from Center Freq ± Sample Rate / 2)
- **Y-axis**: Signal-to-noise ratio in dB (0–30 dB)
- Each decoded burst appears as a colored dot at its detected frequency and SNR
- **Color**: Green = high confidence (≥70%), Orange = mid (40–69%), Red = low (<40%)
- **Dot size & opacity**: Recent bursts are bright/large, older bursts fade over 60 seconds
- **Threshold line**: Dashed orange line showing the configured detection threshold
- **Frequency grid**: 1 MHz vertical gridlines with labels

This provides a real-time view of where Iridium bursts are landing in the frequency band and how strong they are.

#### Tab: Constellation

**DQPSK constellation diagram** showing demodulation quality.

- Displays the 4 ideal QPSK constellation points (labeled `00`, `01`, `11`, `10`) on an I/Q plane
- For each decoded frame, scattered dots are plotted around the ideal positions
- **Scatter radius** is proportional to `(100 - confidence%)` — tight clusters mean clean demodulation, wide scatter means noisy
- **Color**: Green (≥70% conf), Orange (40–69%), Red (<40%)
- Points fade over time; the last 200 frames are retained
- **Sidebar stats**: Frame count, average confidence, average SNR, best confidence, average symbol count

This is a synthetic visualization based on decoded frame quality. It does not display actual I/Q symbols (those are processed inside the C binary) but accurately represents the demodulation quality distribution.

#### Tab: Decoded Data

**Structured frame data table** showing every decoded frame in a sortable, scannable format.

| Column | Description |
|---|---|
| # | Sequential frame counter |
| Time (ms) | Burst timestamp in ms since capture start |
| Freq (MHz) | Burst center frequency |
| SNR (dB) | Burst signal-to-noise ratio above noise floor |
| Noise (dBFS) | Noise floor in dBFS |
| Conf % | Demodulation confidence (green ≥70%, orange 40–69%, red <40%) |
| Level | Raw burst amplitude (linear) |
| Symbols | Number of demodulated symbols (typically 179 or 87) |
| Burst ID | Sequential burst counter from detector |

ACARS, SBD, and IDA decoded lines appear as highlighted full-width rows interspersed with the frame data.

Newest frames appear at the top. The table retains the last 1,000 rows.

---

### Command Bar

The bottom bar shows the exact CLI command constructed from the GUI settings, visible as `$ /path/to/iridium-sniffer -i hackrf-... -c 1622000000 ...`. This is the actual command passed to `subprocess.Popen`.

---

### Backend Architecture (gui/app.py)

- Flask serves the SPA on `/`
- REST endpoints: `GET /api/status`, `GET /api/devices`, `POST /api/start`, `POST /api/stop`
- WebSocket events (Socket.IO):
  - `status` — running/stopped state
  - `stats` — parsed 1 Hz stderr metrics
  - `raw_line` — raw stdout text
  - `frame` — structured parsed RAW line data (freq, SNR, confidence, etc.) used by Spectrum, Constellation, and Decoded tabs
  - `log` — non-stats stderr lines
- The subprocess runs with `preexec_fn=os.setsid` for clean process group termination
- All user-supplied string fields are validated against shell metacharacters as defense-in-depth
- The GUI venv at `gui/venv/` is fully isolated from any other Python environment

---

*End of analysis — NXC2-irisniffer.md*
