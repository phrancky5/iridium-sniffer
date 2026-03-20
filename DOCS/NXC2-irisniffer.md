# iridium-sniffer — Technical Analysis

Analysis date: March 20, 2026  
Codebase version: iridium-sniffer-master  
Analyst, Coder & Architect: Max Elevation

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

## ![][image1]

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

SDR / IQ file  (ci8 / ci16 / cf32)

        │

        ▼  \[samples\_queue — 4096 slots\]

┌──────────────────────────────────┐

│  Burst Detector  (1 thread)      │

│  8192-pt FFT sliding window      │

│  Adaptive noise floor (512-frame)│

│  Threshold \+ hysteresis SM       │

└──────────────────────────────────┘

        │

        ▼  \[burst\_queue — 2048 slots\]

┌──────────────────────────────────┐

│  Downmix Workers  (4 threads)    │  ← parallel, 1 burst per thread

│  Coarse CFO → LPF → 40:1 decim  │

│  Fine CFO → RRC filter           │

│  Sync-word correlation DL+UL     │

│  Phase align → frame extract     │

└──────────────────────────────────┘

        │

        ▼  \[frame\_queue — 512 slots\]

┌──────────────────────────────────┐

│  QPSK Demod \+ Output  (1 thread) │  ← serialized for stdout

│  Gardner timing recovery         │

│  First-order PLL → hard DQPSK   │

│  Unique word verify → bits       │

│  RAW formatter → stdout          │

└──────────────────────────────────┘

        │

        ▼  \[output\_queue — 1024 slots\]  (optional slow path)

┌──────────────────────────────────┐

│  Frame Output  (1 thread)        │

│  IDA decode → ACARS/SBD          │

│  Web map update (SSE push)       │

│  Doppler solver                  │

│  GSMTAP UDP sender               │

└──────────────────────────────────┘

---

## Threading Model

| Thread | Count | Synchronization | Role |
| :---- | :---- | :---- | :---- |
| Burst detector | 1 | Reads `samples_queue`, writes `burst_queue` | Sequential FFT state machine |
| Downmix workers | 4 | Reads `burst_queue`, writes `frame_queue` | Parallel per-burst DSP |
| Demod \+ output | 1 | Reads `frame_queue`, writes `output_queue` | Serialized demod \+ stdout |
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
4. **FFT shift \+ magnitude²**: `fftshift` \+ `|X|²` (SIMD)  
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
2. **Anti-alias LPF \+ decimation**: 200-tap LPF (Nyquist 100 kHz, 40 kHz transition), 10 MHz → 250 kHz (1/40 ratio)  
3. **Noise-limiting LPF**: 25-tap at 20 kHz cutoff applied zero-phase (half-filter flange)  
4. **Burst start detection**: Box-filter magnitude smoothing (\~2 sps), 45% of peak threshold, backtrack to preamble  
5. **Fine CFO estimation**:  
   - Square the signal (removes BPSK/QPSK modulation, isolates 2× CFO tone)  
   - 256-point FFT with 16× frequency oversampling  
   - Quadratic interpolation for sub-bin precision  
   - Normalize: `f_cfo_fine / (FFT_size × 2) × f_sr`  
6. **Fine CFO correction**: Rotate by `-2π × center_offset`  
7. **RRC matched filter**: 51-tap Root-Raised-Cosine (α=0.4), centered convolution  
8. **Sync word correlation** (DL and UL in parallel):  
   - Pre-computed templates: DL \= 16-symbol preamble \+ 12-symbol UW; UL \= 32 \+ 12  
   - Pulse-shaped with RC filter (51-tap), reversed \+ conjugated for matched filter  
   - Padded to FFT size, correlated via FFT→multiply→IFFT  
   - Find peaks with quadratic interpolation; select best direction  
9. **Phase alignment**: Rotate by `conj(correlation_peak_phase)`  
10. **Frame extraction**: 131–191 samples (DL/IBC) or 80–444 (UL/IRA simplex) at unique word

**Output:** Downmixed frame at 250 kHz / 10 sps (`downmix_frame_t`)

### Stage 3: QPSK Demodulation (`qpsk_demod.c`, 538 lines)

**Input:** Downmixed frame at \~250 kHz, 10 samples/symbol

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
6. **DQPSK differential decode**: `d[i] = (s[i] - s[i-1]) mod 4` → dqpsk\_map\[d\]  
7. **Symbol-to-bits**: QPSK → 2 bits/symbol, MSB first  
8. **Confidence**: Fraction of symbols within ±22° of ideal constellation point  
9. **Per-bit LLR** (if `--chase`): `|Re/Im(PLL_phase)| × scale` for soft-decision BCH

**Output:** RAW frame with 179 symbols / 358 bits \+ confidence \+ metadata

### Stage 4: Frame Output (`frame_output.c`, 362 lines)

Formats and writes the iridium-toolkit RAW line to stdout:

RAW: i-10-t1 0000442.4080 1624960925 N:10.77-71.83 I:00000003560  50% 0.11738 179 001100011011...

      ──┬───  ─────┬─────  ────┬────   ──┬── ──┬───   ──────┬────  ─┬─  ───┬──  ─┬─  bits...

        │          │           │         │     │              │       │      │     │

     file\_info  time\_ms    freq\_hz    mag\_dB  noise\_dBFS    burst\_id conf  level syms

Optional ZMQ PUB publishes the same line to `tcp://*:7006` (default) for multi-consumer setups.

---

## Key Data Structures

| Structure | Approx Size | Lifecycle |
| :---- | :---- | :---- |
| `burst_data_t` | 1–10 MB | Created by detector per burst; freed after downmix |
| `downmix_frame_t` | \~100 KB | Created by downmix worker; freed by demod |
| `demod_frame_t` | \~50 KB | Created by demod; freed after output |
| `ida_burst_t` | \~1 KB | Created by demod; freed after IDA reassembly |
| `burst_detector_t` | \~50 MB | Global singleton; includes 16 MB baseline history |
| `burst_downmix_t` | \~20 MB | 4 copies (one per worker); holds all FFTW plans \+ filter state |

**Ringbuffer** (inside `burst_detector_t`): 1.25× max burst length, circular write pointer, sample-level indexing. Avoids per-burst heap allocation in the hot path.

**Baseline history** (inside `burst_detector_t`): `512 × 8192 × 4` bytes ≈ 16 MB. Running sum per bin across 512 FFT frames for the adaptive noise floor.

**FFTW plans** (inside `burst_downmix_t`): CFO (256-point × 16 oversampling), correlation (8192-point × 2 directions). All created with `FFTW_MEASURE` under `fftw_planner_mutex`. Per-burst planning is a one-time cost persisted via FFTW wisdom.

---

## Component Reference

| File | Lines | Responsibility |
| :---- | :---- | :---- |
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
| :---- | :---- | :---- | :---- |
| AVX2+FMA | `-mavx2 -mfma` | 256-bit | \~1.9× |
| SSE4.2 | `-msse4.2` | 128-bit | \~1.5× |
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
| :---- | :---- | :---- | :---- |
| OpenCL | OpenCL 1.2+ | NVIDIA, AMD, Intel | Default when available |
| Vulkan | Vulkan 1.2+ | Modern GPUs, Pi5 | Pi5 VideoCore VII passes validation but cannot sustain batch FFT throughput |

### How It Works

1. `dlopen` tries `./libiridium-sniffer-gpu.so` then the system library path  
2. GPU context is created inside `burst_detector_create()`, batch size \= 16 FFT frames  
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
| :---- | :---- | :---- |
| FFTW3 (float) | `libfftw3-dev` | FFT backbone |
| pthreads | (POSIX) | Threading |
| libm | (system) | Math |

### Optional SDR Backends

| Library | Package | SDR |
| :---- | :---- | :---- |
| libhackrf | `libhackrf-dev` | HackRF One |
| libbladeRF | `libbladerf-dev` | BladeRF |
| UHD | `libuhd-dev` | USRP B200/B210/N200/X300 |
| SoapySDR | `libsoapysdr-dev` | RTL-SDR, Airspy, LimeSDR, etc. |
| SDRplay API 3.x | (sdrplay.com) | RSP1/RSP2/RSPdx |

### Optional Features

| Library | Package | Enables |
| :---- | :---- | :---- |
| libzmq3 | `libzmq3-dev` | `--zmq` PUB/SUB fan-out and `--zmq-sub` input |
| libacars-2 | `libacars-dev` | ARINC-622, ADS-C, CPDLC decoding in `--acars` |
| OpenCL | `ocl-icd-opencl-dev` | GPU burst detection |
| Vulkan \+ glslang | (varies) | Alternative GPU backend |

### CMake Build Variants

cmake ..                          \# Auto-detect all features

cmake .. \-DUSE\_OPENCL=ON          \# Force OpenCL GPU

cmake .. \-DUSE\_VULKAN=ON \-DUSE\_OPENCL=OFF  \# Force Vulkan GPU

cmake .. \-DUSE\_OPENCL=OFF         \# CPU only (no GPU)

cmake .. \-DCMAKE\_BUILD\_TYPE=Debug \# Debug \+ AddressSanitizer

### Build Output

- `iridium-sniffer` — Main binary  
- `libiridium-sniffer-gpu.so` — GPU plugin (if GPU enabled); loaded at runtime

---

## Notable Design Patterns

### 1\. Ringbuffer for Zero-Copy Burst Extraction

The burst detector maintains a circular IQ buffer of 1.25× the maximum expected burst length. Bursts are extracted by index range, avoiding per-burst `malloc`. Edge cases (wrap-around) are handled at extraction time.

### 2\. Three-Tier SIMD with Function Pointers

ISA capability is checked once at startup via CPUID. Global function pointers are set to the best available implementation. No per-sample branching; call overhead is one pointer dereference.

### 3\. Dual Unique Word Direction Check

The downmix stage correlates for both downlink (DL) and uplink (UL) sync patterns simultaneously. The demod stage also independently tries both UW directions. This dual-check recovers frames where the downmix stage guesses the wrong direction.

### 4\. Soft Unique Word Rescue

If the Hamming distance check on the unique word fails (\>2 bit errors), a secondary check measures angular distance to the ideal QPSK constellation points. This rescues approximately 3 additional frames per 60 second recording with no cost on the normal path.

### 5\. FFTW Wisdom Persistence

FFTW plans are created with `FFTW_MEASURE` (benchmarks multiple FFT algorithms at plan creation time). Plans are saved to `~/.iridium-sniffer-fftw-wisdom` on shutdown and loaded on startup. This eliminates the 30–60 s delay on ARM systems after the first run. A `fftw_planner_mutex` serializes all plan creation/destruction calls across threads (FFTW planner is not thread-safe).

### 6\. Output Stage Decoupling

The demod thread writes RAW to stdout immediately (hot path). All slow work — web map SSE updates, ACARS text decode, Doppler solver, GSMTAP UDP — is dispatched through `output_queue` to a dedicated frame output thread. This ensures the demod thread never blocks on I/O.

### 7\. GPU as a Runtime Plugin

`libiridium-sniffer-gpu.so` is loaded via `dlopen` at startup. If the file is missing, GPU loading fails silently and FFTW is used. This avoids linking GPU libraries into the main binary, keeping it deployable on systems without GPU drivers.

### 8\. Multi-Burst IDA Reassembly (16 Slots)

IDA frames are multi-burst: a single logical message spans multiple RF bursts. The IDA decoder maintains 16 concurrent reassembly slots, matching bursts by frequency, time proximity, and sequence number. BCH(31,20) with the poly=3545 polynomial corrects up to 2 bit errors per 31-bit block.

### 9\. Dynamic Array Growth

Peak arrays, burst lists, and similar structures start at capacity 64 and double on resize. `realloc` is called only when capacity is exhausted, amortizing allocation cost in the tight detection loop.

### 10\. Blocking Queue with Weak Operations

The fair blocking queue supports both blocking and non-blocking (weak) push/pop. Non-blocking operations allow the detector to discard bursts when workers are saturated rather than stalling, preventing unbounded queue growth during high-burst-rate periods.

---

## SDR Backend Abstraction

All SDR backends implement the interface defined in `sdr.h`. The `main.c` code selects the appropriate backend at startup based on the `-i` argument prefix:

| Prefix | Backend | File |
| :---- | :---- | :---- |
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
| :---- | :---- | :---- |
| ZMQ SUB | `--zmq-sub[=ENDPOINT]` | ZMQ SUB socket, any ZMQ PUB publisher (e.g. GNU Radio) |
| VITA 49/VRT | `--vita49[=IP:PORT]` | UDP VRT signal data packets, parser in `vita49.c` |

---

## Optional Features

### Web Map (`--web`)

- Embedded HTTP server (no external dependencies)  
- Server-Sent Events (SSE) at 1 Hz for real-time browser updates  
- Leaflet.js \+ OpenStreetMap tiles (loaded from CDN)  
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
- `--feed[=PROTO://HOST:PORT]`: iridium-toolkit JSON format for acarshub/airframes.io (repeatable, max 4\)

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
- N controls the number of bit-flip combinations tried (1–7 bits; recommended: `--chase=5` \= 31 combos)  
- IDA frames only (IRA/IBC Chase is disabled)  
- Off by default; experimental

### Burst IQ Capture (`--save-bursts=DIR`)

- Saves `<timestamp>_<freq>_<id>_<direction>.cf32` \+ `.meta` per decoded burst  
- IQ at 250 kHz / 10 sps, RRC-filtered, aligned to unique word  
- Use cases: RF fingerprinting, demodulator development, regression testing

---

## Performance Benchmarks

### File Processing Speed (60s cf32, i7-11800H)

| Configuration | Wall Time | CPU Time | Realtime Factor |
| :---- | :---- | :---- | :---- |
| AVX2 \+ GPU OpenCL | 15.1 s | 23.6 s | 4.0× |
| AVX2 only | 12.0 s | 21.5 s | 5.0× |
| SSE4.2 only | — | — | \~3.5× (est.) |
| Scalar \+ GPU OpenCL | 16.1 s | 42.6 s | 3.7× |
| Scalar only | 13.0 s | 40.6 s | 4.6× |

### Frame Recovery vs gr-iridium (same 60s file)qq

**At default 16 dB threshold:**

| Metric | iridium-sniffer | gr-iridium |
| :---- | :---- | :---- |
| Detected bursts | 5,468 | \~3,666 |
| Decoded RAW frames | 3,701 | 2,713 |
| Ok rate | 68% | 74% |

**At matched 18 dB threshold (apples-to-apples):**

| Metric | iridium-sniffer | gr-iridium |
| :---- | :---- | :---- |
| Detected bursts | 3,668 | \~3,666 |
| Decoded RAW frames | 2,737 | 2,713 |
| Ok rate | 75% | 74% |

**Interpretation:** The lower default threshold (16 dB vs gr-iridium's 18 dB) catches more marginal bursts, increasing total frame count by 36% at the cost of a lower ok% figure. The ok% metric measures the fraction of detected bursts that decode — not total frames recovered. What matters operationally is decoded frames per second.

---

## Output Format

### RAW (stdout)

RAW: i-10-t1 0000442.4080 1624960925 N:10.77-71.83 I:00000003560  50% 0.11738 179 001100011011...

| Field | Example | Description |
| :---- | :---- | :---- |
| file\_info | `i-10-t1` | SDR interface identifier |
| time\_ms | `0000442.4080` | Burst timestamp in milliseconds |
| freq\_hz | `1624960925` | Burst center frequency in Hz |
| N:mag | `10.77` | SNR-like magnitude in dB above noise floor |
| noise | `-71.83` | Noise floor in dBFS/Hz |
| burst\_id | `I:00000003560` | Sequential burst counter |
| confidence | `50%` | Fraction of symbols within ±22° of ideal QPSK point |
| level | `0.11738` | Raw burst amplitude (linear scale) |
| symbols | `179` | Number of demodulated symbols |
| bits | `001100011011...` | Demodulated bit string |

### stderr (stats, 1 Hz)

Same format as gr-iridium status output, compatible with existing monitoring scripts.

---

## File Inventory

iridium-sniffer-master/

├── main.c                  Entry point, threading skeleton

├── options.c               CLI argument parsing

├── iridium.h               Global constants, frame type enums

├── sdr.h                   SDR backend interface

│

├── burst\_detect.c/.h       FFT burst detector

├── burst\_downmix.c/.h      Per-burst DSP pipeline

├── qpsk\_demod.c/.h         DQPSK demodulator

├── frame\_decode.c/.h       IRA/IBC frame decoder

├── frame\_output.c/.h       RAW printer / ZMQ PUB

├── ida\_decode.c/.h         IDA multi-burst reassembly

│

├── sbd\_acars.c/.h          ACARS/SBD higher-layer decode

├── web\_map.c/.h            Embedded HTTP server \+ Leaflet.js

├── doppler\_pos.c/.h        Doppler IWLS position solver

├── gsmtap.c/.h             GSMTAP/Wireshark integration

├── vita49.c/.h             VITA 49/VRT UDP input

│

├── fir\_filter.c/.h         FIR coefficient generation \+ convolution

├── window\_func.c/.h        Blackman window

├── rotator.h               Complex frequency rotator (inline)

├── net\_util.h              UDP/TCP helpers (inline)

├── wgs84.h                 WGS-84 Earth model constants

├── pthread\_barrier.h       POSIX barrier polyfill (macOS)

│

├── blocking\_queue.h        Fair FIFO blocking queue (556 lines)

├── fair\_lock.h             Ticket-based reader-writer lock

├── fftw\_lock.h             FFTW planner mutex

│

├── simd\_kernels.h          SIMD dispatch table

├── simd\_generic.c          Scalar fallback kernels

├── simd\_sse42.c            SSE4.2 128-bit kernels

├── simd\_avx2.c             AVX2+FMA 256-bit kernels

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

│   └── cmake\_uninstall.cmake.in

│

├── opencl/

│   └── burst\_fft.c/.h      OpenCL GPU plugin source

├── vulkan/

│   └── burst\_fft.c         Vulkan GPU plugin source

├── vkfft/

│   ├── fft.h               VkFFT wrapper

│   └── vkFFT.h             VkFFT header-only library (MIT, \~25K lines)

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

---

## Mission Control GUI Reference

The Mission Control GUI (`gui/`) is a Flask \+ Socket.IO single-page application that wraps iridium-sniffer with a real-time browser dashboard. It runs in an isolated Python virtualenv on port 5050 (configurable).

### Launching

cd gui

bash launch-gui.sh 5050        \# creates venv, installs deps, starts on port 5050

\# or manually:

source venv/bin/activate

python3 app.py 5050

Open: `http://localhost:5050`

---

### Sidebar Controls — Complete Switch Reference

#### Input Source Panel

| Control | Type | Default | Description |
| :---- | :---- | :---- | :---- |
| **Mode** | Dropdown | `Live SDR Capture` | Switch between live SDR capture and IQ file playback |
| **Device Type** | Dropdown | `HackRF One` | Select SDR backend: HackRF One or RTL-SDR / SoapySDR. Selecting a type auto-fills center frequency and sample rate defaults for that device |
| **Interface** | Text \+ SCAN | Auto-populated | Device identifier (e.g. `hackrf-000000000000001a`, `soapy-0`). SCAN button auto-detects connected devices on page load |
| **LNA Gain** | Slider | 40 dB | HackRF LNA gain (0–40 dB, 8 dB steps). Maps to `--hackrf-lna` |
| **VGA Gain** | Slider | 20 dB | HackRF VGA gain (0–62 dB, 2 dB steps). Maps to `--hackrf-vga` |
| **RF Amplifier** | Toggle | OFF | HackRF 14 dB RF amplifier. Maps to `--hackrf-amp` |
| **Gain** | Slider | 30 dB | SoapySDR overall gain (0–50 dB). Maps to `--soapy-gain`. Only visible when RTL-SDR/SoapySDR selected |
| **File Path** | Text | — | IQ recording path (only in File mode). Maps to `-f` |
| **Format** | Dropdown | Auto-detect | IQ file sample format: `cf32`, `ci16`, `ci8`, or auto. Maps to `--format` |

#### RF Settings Panel

| Control | Type | Default | Description |
| :---- | :---- | :---- | :---- |
| **Center Freq (Hz)** | Text | `1622000000` (HackRF) / `1625500000` (SoapySDR) | L-band center frequency. HackRF covers the full 10 MHz Iridium band; RTL-SDR covers a 2.4 MHz slice. Maps to `-c` |
| **Sample Rate (Hz)** | Text | `10000000` (HackRF) / `2400000` (SoapySDR) | ADC sample rate. Maps to `-r` |
| **Threshold (dB)** | Slider | 16 dB | Burst detection threshold above the adaptive noise floor. Lower catches more marginal bursts at the cost of ok%. Range 10–24 dB. Maps to `-d` |
| **Bias Tee** | Toggle | ON | Supplies DC power to an active antenna over the coax. Maps to `-B` |

#### Processing Panel

| Control | Type | Default | Description |
| :---- | :---- | :---- | :---- |
| **SIMD** | Dropdown | Auto | Force SIMD tier: Auto (best available), AVX2, SSE4.2, or Scalar. Maps to `--simd` |
| **Chase BCH** | Dropdown | Off | Soft-decision BCH error correction. Higher \= more bit-flip combos tried (3→7, 5→31, 7→127). IDA frames only. Maps to `--chase=N` |
| **Gardner TED** | Toggle | ON | Gardner timing error detector for symbol recovery. Disabling falls back to simple 10× decimation. When OFF maps to `--no-gardner` |
| **GPU (OpenCL)** | Toggle | OFF | Use GPU for burst detection FFT. Requires `libiridium-sniffer-gpu.so` and OpenCL runtime. When OFF maps to `--no-gpu` |
| **Verbose** | Toggle | OFF | Print verbose diagnostic messages to stderr / System Log tab. Maps to `-v` |

#### Features Panel

| Control | Type | Default | Description |
| :---- | :---- | :---- | :---- |
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
| :---- | :---- | :---- |
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

- **X-axis**: Frequency in MHz (derived from Center Freq ± Sample Rate / 2\)  
- **Y-axis**: Signal-to-noise ratio in dB (0–30 dB)  
- Each decoded burst appears as a colored dot at its detected frequency and SNR  
- **Color**: Green \= high confidence (≥70%), Orange \= mid (40–69%), Red \= low (\<40%)  
- **Dot size & opacity**: Recent bursts are bright/large, older bursts fade over 60 seconds  
- **Threshold line**: Dashed orange line showing the configured detection threshold  
- **Frequency grid**: 1 MHz vertical gridlines with labels

This provides a real-time view of where Iridium bursts are landing in the frequency band and how strong they are.

#### Tab: Constellation

**DQPSK constellation diagram** showing demodulation quality.

- Displays the 4 ideal QPSK constellation points (labeled `00`, `01`, `11`, `10`) on an I/Q plane  
- For each decoded frame, scattered dots are plotted around the ideal positions  
- **Scatter radius** is proportional to `(100 - confidence%)` — tight clusters mean clean demodulation, wide scatter means noisy  
- **Color**: Green (≥70% conf), Orange (40–69%), Red (\<40%)  
- Points fade over time; the last 200 frames are retained  
- **Sidebar stats**: Frame count, average confidence, average SNR, best confidence, average symbol count

This is a synthetic visualization based on decoded frame quality. It does not display actual I/Q symbols (those are processed inside the C binary) but accurately represents the demodulation quality distribution.

#### Tab: Decoded Data

**Structured frame data table** showing every decoded frame in a sortable, scannable format.

| Column | Description |
| :---- | :---- |
| \# | Sequential frame counter |
| Time (ms) | Burst timestamp in ms since capture start |
| Freq (MHz) | Burst center frequency |
| SNR (dB) | Burst signal-to-noise ratio above noise floor |
| Noise (dBFS) | Noise floor in dBFS |
| Conf % | Demodulation confidence (green ≥70%, orange 40–69%, red \<40%) |
| Level | Raw burst amplitude (linear) |
| Symbols | Number of demodulated symbols (typically 179 or 87\) |
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


[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAnAAAAF/CAYAAADJrfTrAACAAElEQVR4Xuy9ZZgcyZXvPR92KqvUrWaqrmZmZia1Wmo1SGoxMzMz02gEI5aGNOABjz1kjwc94AEP2sPrBe/ea+/dx77r9Xr37u59n/f9cN44kV3VVRFZ3Vmtwtb58KuMPBEZmRURGfnPyIB7QmPzwFXC4mQbQRAEQRAE4R3uCY3JgZEIi811ihiWIAiCIAiC8Cz3hMRkgzPC4phAi2UBscXNzIjPVzHnqzarP0M8liAIgiAIgvAM94REZ4JIaEyWilW8WfIhLKEQwhKLBymCMAuKORRxqATV8GI8BEEQBEEQhPtxLuBis3mrGxduyaUQllYBYRmVKuhGGxNz9iIuJJpEHEEQBEEQhKe5JyQqA+wJjUYBh+ItRxVvqeVQfulPUHrrX6D4sf8NBT/6I+T85A+Q9cYfILK6m4Up4iIuDEUcRmqNx5wLISgEUeAxuG1wG8LEYQi6cYv71uPwGPstDzfoZvHb3FZw39ryx67XZhO3rrgJgiAIgrjrCcouAcPTR2BcawsEl1R5nKCKGjBuXwLGrYuka9HinvHsx0pINJLJxVJoQgETb2VQcfgfofLSf0D5rf+Akif+HfJf/jfIefPPkPX+nyHj03+F0LQKCE0sVAXWoJjCuFI++C1EtA1A7M77IP7cYxA1ey2kfP3P3C/28CW+TXz/GwgtaIDw2i6+H//iWxBiyYf4n3/M96PW7wbza++pfp99CfHf/MZ2rXE/eZUdWwfh9V0QWtoMcd98pcb9za/5NubLT2F8UgFEv/Aj2zHR36jxIhGXztvckV+9CyHNXRD++A2bjSAIgiCIuxPjuc0QXFrlM4wHV0vXJMIEXDpYsQk4MxNwiUWQOukQ1J38b6g5919QefU/ISynCUKyqiHtyc8h47N/g/Sv/gwJT78Focn4KdXaGoYRp0Pqh//IBNx0sNx8HpJ+9jkTemWQ8s0fuF/sERRw6RCaUQGW594YFHDpEP/Sz5mAy4P4dz7h+1EbdkPUmh0wPi4bojbthfhv/8Z2rVF7joD52+9gfEwmE3BNELXvCETMXwGx337J/WO++lwVcD9/DcLmLua26G8/Ye5F6vHffQSR333I3ZFfvwdhF85A6KQ+W/wEQRAEQdyFxGUyEVXpc8ZN7JCvzY57xkemgkoahESlqSKOibEwJsqqTv0L1Bz/M9Qe/Q8YFxLHiLWR/OY3kPzlP0HSl/8DQlNLIdSCAg4/habxuFJ+8XcQ0ToNYnechqQ3v4KQxAJIYeHxXLGHLqrbA+cgetFGCK/u5Pvmh3/IhF4JWN7+hO9HrdsJYQV1YH7lLQhhYiz+q+8Hr3WImKu3ILS4ESK37YXYt96E2K++UO2/+hjGJ+ZB9I9/aAsb/dVHNnfExftt7shfvw3ht69BSE2zFD9BEARBEHcPxg3zIbik3Ma4gW4YN7ePE1xe5eDnSYz3b5auzR47AZeqCriYDC7GwlJLoOSB33OiS/scxBsSZE4Hy9d/w8HWtdAE7NNmFXBMIDX2MtFVCKH5dXw/vKWfg+7Qwnrm7uOijJ+XHWu9hvBWdlxivhoupxJCzNkQ1trD961b7lfVxvanqMfHZ0NoXpVqb52sblsmwfjodAitaRs6pnWSnbsLQhj8+JaJ6rZV3RIEQRAEcXeiXNzKBFSFjXHLZoDyyllQnjsO4/q7uM3w6Y0h/0XTILiuDpRzm8F4fK3q/9Jp1b+yGgy/fgiCJrbDuDl93KY8sp+F3QLjpk4G44l1oDx7zOF8VoJqaqVrs+ee4IhksDI+MgXGo4hDQZRcBHnXvoe8699C3MB2ScAFt3ZC7BefQNwXn0FoSjE7JocLJozDPk6CIAiCIIhAQTm5DoKKymyY5vQyQXYKlEMrYVx7M7cZPrk+5L9+LhgPrgTlzAYIqq5R/X98XPVn+xh23IRWCCqt4Dbl1m5Q7tsAhrObwHhkDR8oEVRSDkFV1Q7nHTexTbo2e5iASwIr4yOZiItKgRBzBv/kmfXQF5Bx+zNIeeoDGBdmHhJwoXEQ8elrEPXFexDz+QdM7BUyAZfFBByqQox4KE6CIAiCIIhAwTivjwmoUhvj6mvANLMbTP0THeyexnBlu3Rt9twTHM4cg4yPQBGXAuNj0iHEkgsRdVMg5blPwPIyE2pvvQbB65eBcck0CP7mBQj95jWI+OYdCN+9k38CDYnF1jcm4FAZ2sVJEARBEAQRSARVVEqCyqtUV0NQcal0XfYwAZcI9nARh61wcdgKx0Rc5wDEvs7E2rsvQvAnz4DyzW0Y9/WzMP7rFyH0Z7dZmDwYH4cjT1P4scERajw5pa1Q3tTP3en5tZCUXcndYTFpkJZXw93hTPRNW7ydu2MT86GgqhNScqps1xKBI0EG3VnFTTZ3eVOvzd3QNcfm39g1jx2TMRh3BkSah45Huuesh+q26dxdVNNls5fUTWZx9jmEFUH/1Nxq7o5h/7myRf1v9kTFZ9vcdR0zB+PuhtDoVO4OH7w2JCmrgm9zy1pttmz2HyLNWVK8BEEQBEF4j6CYFFAOrYBxRSVMUHkX44oBCIpCkSZflz33BIUlgAhvnkNBhq1qOKChdwaEffQiBP3qWVC+fxxM3zMBN2M6jE/K5+ItGAUKb3lLtMWRmFEGKdlV3J2eV8u3C9YfdThPWEw6VLVM5e6QyBQoZAIuOavS5h8SmcxEUy2Es3BdA6tt9rzydqhpHeDuholz+Ta7qAkqm/u5O9qSA02T5nMBaH8+3M8paeFuFHC4xWtMzChn4m6DLVx+RbsNq62CCbjYpALuLmvogabJC7gbWxxDWFpNnL7K4VzxKUV8iwIuv1yNB0Wl1T8ps4JvW7oX2tnKHfYJgiAIgvAd43ILAT+d8k+onmZgEpia6qVrcAYTcBYQCQ5PUBVeFBNlsWkwPj4Txifk8NY2TkIuE3ZZTLylc6GntrrhMRipHB9BEARBEAThPu4JCo0HLYKZJweFHA5MQKGGLW0IuiPVz6XjUbhhZBpxEARBEARBEO6HCTgzOCM4DIUcI3ywVS5iEL6PAk/1F48jCIIgCIIgPMc9OCXISASFmWUGIxDDEgRBEARBEJ7lHnGCXoIgCIIgCMK/uSc8LgsIgiAIgiCIwIEJuGwgCIIgCIIgAgcScARBEARBEAEGCTiCIAiCIIgAg/rA+TvxuWDJaoD41HJiNKRVgKVgopyu5hywFE7k/tIxhC4s+R0QYcmX0tZcOImla6UUntBJZh2Y8zuldI3LnwAW5ieFJ3RhZmXSwsqmmK5YhrEsU10wejTrWIalpJfS9U7IqofYnBYpXa2QgPNzLIVdcqYSLhOdXuOYrqzCEcMQroMi2D5do5LlMMToiEwodEhb0Z8YHVHJZUJd0CmFIVzHUtztkK4xGfSy4S7UFjdZHwwr4OYsXi/ZCO8iZiQxOhIqZzmma2a9FIYYHfbpGpvTJvkToyM6vZbqAg8QJ7Ruiv7EKMkQXpLLpsthiFGBX4zs09aKUwH38mvvQfukmZIdmbN8J9+evvZD6J2zjruPPfAD2HzgIpTWToKYpAI4eeUZbp8ya7XtuEPnbkNVcy+YU4tt+7itbumHResOQFFVJ+SVtXHbwfsftR139tbz0jXcLYgZ6RNy2JtURpVsR9CO/tZm8qwaiM+uVd2Z1aofIh7nZUQBZ/EDAWfOqgJzdrVkt/mjnzVd2dacMxQW3Xw/w/efKu3T1R8EXFqmSmqGo00MZ++XlC6HSxy0+Qp/EnAWbE2xfQqrGPZTriW9moUfrAMGqdj0FViym6SwviDQBJyFpXcyT28//xTJ8t2hjg0AAZfGynRSmmz3N4YRcHLHOKSsdiL0DiyBi9cek/zmrdrDt/ffegHOP/wSd5+8+qzNv7S+Gxau2c/dvXPW2uxzVuyCY5ee4u6mrjmwYutx7t6w9xzUd8yAououyCpqYgKwkAu4yqZeW9jI+FzpOu4GeKXpQ5LufwISlu+FtC//RfJDUj//Z0hcexjSvv4TxNf1QOqb30Hyhach+dbLkHj8QUhYtB0Spq6QjvM2iVVzHNKV9yvUCOctwjYvg3HPHIegRw9JfojhiwchbOtyMHz3qLr/zSMQOX8mmN64wPeVD69B1LR+iC1tlI71NvbpGpfbLvl7m1nNlfDhzlrY3a8K4LaqSpjBbGI45JFlNbC8swr++0I9ZOVUQGVxBeyeWgVf7BsULD4kmokmf6gLqrb/HeT2XYT6I//J9+sO/TtktO6AusF9kdoD/woly16H3N5zNpv1WH/AXNDlF+mqlydO/Sf0dh2Ap+77fyQ/v4K3wA2la0LFDDmMHzE5twrWFtXBb1raoCRTu37wF8LN2vrHqYBDUrIrJRvhXcSM9BWpH/yDZLMn7Zs/g6V5GiTfZMJt6W5IvvwcJJ54CBI3n4SEORul8N4msXquQ7r6WsBZiStvkmz2GL6/rW6ZgItt7ADTy/fxfeXTmxC5YJYU3hfYp2tc3mBncB/z6Z46SEhX3f/fpQZYO3mwNVPgy/11UFpYCX88Uw/pWRVwYlYNvLC+FhrLfV+h+4uAs1J/9L/5FgVacuk0qN3/v6UwSN7ATeY/nYm412y2osUv82121xEoW/M+E4F/UVvpNI73NIEm4J4++/9CVv4EvhX9/IoMbDEeSld/F3BXKhshk9URp8oboDdPu37wF0Yl4AjfI2akL0j99J8gYeY6yY5YqiZz8Raf1whJZ5+AhCW7wFLfC6nv/3YoXGGLdJy38UcBF7ZjJSgfXZfsVrC1zSrwrEJO+dWDNn/8xKp8fks6ztvYp6u/CDgEhVtBfiU8u6YGcnMr4O+Pya1qKOBwiwIOt/0NlXBqdjX8+7l6aK30rYjzJwFXvuEzSCqawt1cyKVX2wSdiCjgSpa/YfNLKurhLXiqgPPNQzMQBZz91m8JQAGHWxJwhMcQM9LbJO4+Dwnrj0BC3zKIz1UfcinPvmfzT/vqT5Awaz33T9hxH6Q89TYkHb4OKa9+CcmPvspE3eOQ/PjrUrzext8+oUYsnQvK+1chuq8P4gpUERGxcQlEzp3J3djSFnJiE/fHfcO3j3K38svrPDwKueBreyDo+j4pbm9jn66+/oSayN6o/+tCPVxdVA3fHKyFjOwK+Jf76uEnG2rhysIaHubf7q+HfdPUCvvRZTWwpKOKH4P7726vheOzVL8jA76t1KPT/UPAla54CwrnPAmp1Yv4Pn4OTW9Ya/uEiv1JK7d8awtfu/9PULLkp5Dbe57v1x3+Pza/wnlP83gwfEJOq3Qub2DmU174Pl31gp9Qp3TupU+obmZKbhWsLKqF71raoNTvP6FiHzhZH2gOYkiomk14EDG9h0PszOh1CprUFjQkXe0wj/3ebP5WPwT389hbTUGz4/H5vu+87G+DGMy5NWAurONYByKYnj8FsbWtqv+gH/fHY1gYmxv9s6vZg8ixo7ivsE9XfxjEkJJRDjk5Q/s4MCE7e2g/i7kT7Dou5+aox1gG93Gbmzu07yv8ZRBDQnYLE1sq3JZWyW32YezvJ3QnZKn3fGrNEiha9KJjfBhXVqN0Hm8RcIMYWHqnszTDwQyin18RgIMYctgLX2pgD2KQjYT/IGakP5D00E8lm7/jbwJOC+M7D0i2QMA+Xf1BwI0V/EXAjTUCTcAFDAEo4AIFEnABipiRxOgIBAEXqNinKwk490ECzjOQgPMQJOA8Bgm4AEXMSGJ0iJ+uLVkk4NyFfbrGYh84jTCE65CA8wxx+dgHjtLV7YgT+ZYPyGGIUTGMgJM7xhH+g9iZ0de09CyBvIrBNUQHsaRXQVaJ2nkd/Urr1Y73/oQ/jkK1klM2gW8bJy2AzumrISWnHuonzoPswTRt6VkKrQx0ZxQ2S8f7Gvt09adRqMikmesgIbMasks7WPoutNnLGvshESedZu4c5mfB/p0ax/sSfxqFqkV6QQskZ9dBa+9SSMtvgoKqSVDRPI0xHdp61fLqj/j7KNQJU1fybVZxm7o/bRUU1agjgKvb1EFOtR1zpON8jp+OQk3KUqerwXu+qnUGK7O1kJxTB8V1PdDcvRhq2mfzehfT1lpHlLBnGJZjMS5f4dIoVHNqKRTXTubu1Nw6mDiwGrpnrYMIpgKTsqqk8ITnEDPS15SzCtr+YZeIqy3Y+VvFXVXLgHSsL/G3Uaj2oIDAbWPXAl5Zt/Uth7KGqVzA9c7fArUT5jABt8QWPsMPpmWxxz5dfT0KVWRg6W4uiDEt23EkNbMlZFTZxHHvvM2QUdTKO4qn5fuXOA4MAVfL64O0/EaoZPc8uvsXbmNleb4U3l/wdwGHz1vcWutWLKulDepLMboRFBzicT7HT0ehWgUclteq1gGWrjWsDm3ldWobqxOwDHeyejc1rxEa2Es0hi2p74XC6slSXL7CJQEXZcmzuWs7ZkFH/wronr0e4pmwS8qqhuiEfOkYwjOIGUmMDn9ugQt07NPV31rgAhl/F3CBir8LuIDFT1vgxgLDCDj5uyrhP5jT1CkmiDvDUj7dIV3jUcBphCNcw5yGLfJD6RprnWqCuGOi0xw7hYv+xOjAfppUx7ofcya+cNiV19J+KQwxOobpAycbCf/BUkY3gTuIiMdW5aF0NRd1S2EI17GU9DiWWfamGJ9eJYUjXAQ/R5nxLXsobdEmhSNcRm3NsKtjS/ukMMQoEOuC+Hw5DOE6mQ2O6WqHpoCLze+EkJgMGB+ZTLiRUFZxxGS3SOk9ElEp5RDDMpEYBRl1TLw5Vtg2mB0/U0nHELqItGBXCo10ZVC6jp7oVFyDWk5Tnq7MTwxP6APLJPbjFtMUibAUsLqiXjqG0IfTOhbLLNUFoyYq2XGUv4imgBOFB+FOUqT0JgiCIAiCcAXNQQwoMgjPIaY3QRAEQRCEK4wo4B587Ic29+WbT0hixJ6C0iZ44advc/f3f/9PUFDWBH/92/8FrROn2cKU106AX337W+lYZPnaHZJtLCKmN0EQBEEQhCu4JOAeuPE4LF65BXoHFvH91Rv3wIatB2z+mfk1cOORZ2z7KOA++vxbKKvpsNkeefJ5vk3JKoOps5ZBbGIeE3jTYd2WfTYB9+rPP4KYhFxIza7g+zlFdbBk1VZ496NfO1xboHD+yiM8DXKK6vm+mN4IzrpOEAThKlGpVZKNIEZNWrVsI/ySEfvAPXj7h9DY3gv1rVOYmHuOCa5cePFn73C/VRt2QXpOpS3s+q374fT5G9zd3NEP+aWN3D1v8XpbmAeu34bZC9fAxau3oa1rOo9v14FTMHP+Kli2Zhs/1y8+/gp2HzjNBFy57bgZc1fAnkOnHa4tkJjUP8/mFtMbGRcSSxAEQRAEoYsRBRzhfsT0JgFHEARBEIQrkIDzAWJ6k4AjCIIgCMIVtAVcVKokOgj3IM4CTgKOIAiCIAhX0RzEgMQVdPHlhwj3EZ2BMyrLaY2IGUMQBEEQBOEMpwKO8C5ixhAEQRAEQTiDBJyfIGYMQRCBifHkGgdEf3dwbV4hPLhgiDSLRQpDEMTYhgScnyBmDEEQgYnh20fBlJhmA20ZeZUwa+kWmDJzuRR+JNKyyyTbf5yrg5ioOE5veSqUZSRCZGwqbNx3P+w8dhUWr9vnEH7LwQuwZsdJKR6CIAIXzUEMhPcRM4YgiMDE8OsHwZSQagNt6bkVMHnaYmhonwoJqQWQklkMyzYegoaOqTA+wgI1zZPhzI3n4OzNH8P5h1+C7UcuwZzl22Hd7jOQnF4IKzYfcTjHn87U2gTclLIUKGUCbvX2E9wvOj4DFqzezeOyhl/KztU3exV09s2XrpcgiMDEqYCbumg7NHbNhdjkIohNKoSkrGpIL8BO+Kp/ce1kiIzP5e6WKYv4tqSu2+YfGZ8DCRnlUryENmLGEAQRmBi+fAhMtZU2RH938K/31UJdThJnVWsmb4ETwxAEMbZxKuAmDqyCmrYB7q5unc63KOASMiq4qMsubrGFbelWBVzVYDgEBZwYJ+EcMWMIgiAIgiCc4VTAEd5FzBiCIAiCIAhn0CAGP0HMGIIgCIIgxh7PLC+GxDgzlKYnwuHeHChKTYDXNpZK4UZCU8DFFnRBeGIZhDI34T4i0+ogPD5fSm9/F3BBYfqmKIhIkkfLaRFmKZBsWmCaiTYt9IbzZ8ZHq6MVRyI4Ql9fp/AkfZVBeEKxZNNifGSKZNMiJCZTsgUaITEZkk2LsPg8yaZFUFi8ZNNCb57pLQNjAb33dmhcjmTTIiyhSLJpEZGsry7TWzf6M+E60yTUnCvZtAiJTpdsWoSxZ6FouyNC42SbhwmOSJJsmoSaHfYPTMmF8WGx8A9HqyEyMg5+f6IGarJ1xmWHpoDDyprwEFFpUnqTgNNGf+WtL5w/QwLOfyAB5z/ovbdJwI0eEnCjZ7QCzl1o9oET1+8k3IuY3qPtA2eqZJVMZDyYSovBlKrvoTMa9FZSETofQHpv3NBYnZW3znDDYSoqBOXkajB8eBmUW7vAVK7vv7gLXH9YtGmh9+Ednqjv+vVW3voFnOfKoVeITgDDiyfB8MppGBefLPvbEWZ2s4BLLJFsWugtA2OB0Fh9daNeoRdmKZRsWuh9GdVbN/oz4TrThAScjO570VcCblLfHGifNF0SIYgltZBv5y9ZDx2TZ0BJVSt324eZs3ANxCXlSsfezYjpPSoBF2EG5cHdYJwxEUwdDWB4+wJ/UKAQcDf4UBZtWkSm1Ug2LSKSyyWbFtg6JNq00BtOC1NfBxhfOA1B3Z0QnJZvI6izDZS3LkJwaq50jCfA1hzRpkUIe6CJNi0iU6slmxYRKZWSTQusvEWbFviAFG2BhPKzsxCaW8nLgPGxQ5K/PdhiJtq0wAeaaNNCb57hC4toG6vgC4Zo00JvHRCRUiHZtNBbl2GLs2gLNPSmCb4UijYtwuILJJsWKJJF2x0RnSbbPIzue1HnFxZXGVHAvf3B5/DEsy/BjHkruEg7cvIi1DZPhsy8KqioncDD/OzND+CFn/4c1m7eC/dduGk7Nr+kgW+v3Hgc3nz3E/jq+3+AR3/wPEyduVQSNWOZo6cvQURcJhSUNfF9Mb1HJeAYxumdMC4pjYmQdjBV6mtxGQ163zIjdLb66H3z0tuypvct3R7DSydBWdjjMOGqFsaSIjD84pLH3+7wJhdtWuh949PbmhNuoRY4K4a3L/I8D84otOW/8uwRMEVovz1TC5zn0Xtv660r9LfA6avL9NaN/ozvWuD03T+68XAdrYXue9FXLXA/fPF1uHX7Wfj5+59DaXUbnD53ndvT2Vtq55RZ3H3w+Hl49oXXYN2WfQ7H5peqAu7EfVfg+Z++Bb/57T/Dj3/yFpRUtkoiZywTGp0Kx85ctu2L6T1aAect9FZSeis99ws4feEQ4+oBMPzktLrMkYZgc4ZycwcYF/RI8bkL9ws4fXlBn1BVTNUVYGyulQQcYvjsphQeIQHneXQLOPqEOmp8J+D0PQd0E0AC7vS0PPjx6hI43JsLl+aMPh1GHMQQm5gHMQm5EG3JYe5cJkbSID4FP52mcDfao+Kz2TYbIs0o/hw77WNYDIfxWN3m5AIp3N2EmN40iEEbvZWynnCmtEwwfPUQmDKyHdapdImqcjAu6pPidgcjNbErj+wBw3ePgnJjJxi+fhhMJcMLL70d4mkQg4rhm0ds+RycWeSY7+lZoPzomHSM3hYE3QJOZ57pfmiMAfTc22o4GsQwWvS+xJGAk3FlEIMxOIqD+787XgP/92I9/GRtCSxpGv1L74gCjnA/YnoHgoAzTm4Bw68eBOXEGjAVCw+4QcavXwKGdx8A5dG9w3YA96qAi0sCw+c3pWu9E7AFz9jZJJ/rDsDRyaINKyTDp9fBVFFqO3dQSs7Qdbx5Tj5mEL1iQG/ljeVWtGkRiC1wysXNYErNtKVrcIZG+c7MBuXx/Q7HkYDzPMPe26MIp1vA6XwZdZuAM7N66uVTfB1d44wu2d+dsHpFeWQvr6exbIfmVYOxvorVNTfksHaQgJNxRcBJNjdAAs7LYBO+mN66BdwwosiT8BYfOxHhjLCCeptbObYKjPuWaN5U3hJwpoFOUJ4+JF2nOzC21rMH+gHpnKNFbIEzZeVoCs+g1CEBhxi+fVSKC9ErBqgFLnbok/ogUgucNc9nTuKjVK3HkYDzPM7ubZFAboHDVn0ckGYra+wFGevccVF3HreIiT1DDK+edSjXKOBs9cnr90vHWCEBJ+MHAk7ujxWVXgvRWc2Eu8lognCz9hqxYsaIKDd3guHGTsnuaQxf3IJxyZlSnzAtwgrqHG05uWB45QyY5kx2iBNHKYnn0UJ35a3RB87Izmmc2SVdo7sxPL4flB0LpPO7in0LnHJyDSjHV0vnQoJSsiWb4Qu5j5ZeMXC3t8CZzElgystzSE/eAqeR9jytP7xiO9b9feD05dldJeA07m0t9NYV/tYHTjm8AoxTO6VyxsvaD49K4e8E48rpTCjuks4Tmlc1tJ+XD4bXzkrHIiTgZPxSwBHeR8wYe0xVZWBc1g/K+llD9kS8wY/wueCMi/vA8P4l6bg7BR9WpmR2MyZlSDe9FmH5aidwEd48/9RBW7x6b1zdlbfQ0Rn7KxkntUjX4Sn4SNWfX4BxsaN/sPJBDPjJlF07zkknnsOKloDDPLIXFojeDvF3+yhUrQeaOIjBHmN2LigvnuDHul/A6cuzu0vADV83DoXTV1foF3D6xPSdCDhTchoYu1ulMmaP4eNr0nEuExHPW9aMbfVS/AhOm+Ngy8/nn3PFeNwv4PTdP7rxiYDTeS+SgBvbiBkjEW4G47xuB5vy42N8El/lhRPq50rxmDvA8Nr9thv6TgWcjdw8MPzyGgRtWCSdTwu9lbK1kleeOMCEbp98Xm+Bnz0/ugrGha6NVuX9Bn9wmPezkuIU0BRwg2B/OWucesXA3SzgsOVNWdQrpeNwAs6W1r+65ZcCDu8x3vI8oVHyC0TGqoAz1VSAcft8qVxpoaybBcqyqVIcejC8cxFMBflSnPZIAm4Q/LpgHxcJOJnh7kUHvC7gzDkQEZ/LkfwEf0Ifzj6fImLGiBju38AR7Z4AH072N7LbBNwgITkVvMMsPmiGu+n0VsohaYVqZ3+Nc/kKFKrGjbPVfixhcer/ZCIc+1Ap/RP4Z0/e96pE/VyHE8eKcWgxnIBDDO9f5h2i9YqBu1nAGd5V530T0SPgeFp/cp1/5jIunwbGRT2gXNjM8x37LnI/5LMbvPuDeG4t9OaZw0MDB+k8c5ifyzhrksP1Gae2q/YZE6U4AoUxKeAwz546JJWn4TD2tvMuKVJcIqyeMVWWqPXr1AlSPFo4E3CmgkJQbg2VXRJwMqMVcL8/UQ17u7Pht0eq4Rfb5M/1waGx8G9nayE/ZajPrRaagxiiMxsdOt6H4PqdCcU2/4TSXohPqyBGQULZNCm99QxiMB5YxgcGiHZ3w9/W8vIdOrnyPnAanbpF7AcxDEcIVhjoTs3kTfXG1TN4M794LSP1azEVFKhic9086Rz+Ao4oUy5vA8PtvaAcXQXGrmYpDBKcXiDZtOACTsNuD46WDKtvk9JLC0/0gTOlZHBRY3j+hCpm3jwPyk9Pg/Kj46C8dIp/FjIeXuEwIMDbmLKyQVk1IKUdojkKVYOQnHLJpgW+APHWUfPwg5D09lvEfjfG+VPA8MY5p+VJxPCLyx7pFO9p9AqzkeoKK7oHMXiwDxyKKzF/9GBk5VV5bL/6ImgfJ3tBxM+j+LJgwEFbuXnSscNhP4hBorKcxXmYn2dYAZeUxsui8ug+XifjlwgcJY9dFPCLBHb1MaVnqi+zg8fo7UqjG58IuNH1gcNpRNa2ZcJnuyrg/hmykD3Sp6b1p8xf9LNHU8CJIye5iIvFlqJsiEqtkkQJ4RpieusRcIbzG0E5tFyyuxNTSjooZ9ZLN7F+AVcn2bSwCTh7mBhTLm6Ce9nD3TS5hT9s7CtlU3UZGNfO4BUDrlVqbGuwHTs+q0SOL8AITncUzc7QI+AQzAvjgl7eQoQPDCw7/C0e54+zE8vuEnDKkRU8X4I62qRrcYaxulxtMdSIz6OEqp+txeux4gkBh1su5oe5h0caxGDKzeWrgpha9L0oiRgHJoLy/HEpXn/G7QJOdwucZwScwl5mxHxxFWNWDn9BUrbM42UK620xjCvwQQwadnuUcxshaO0CMOUzcVhcCMb+DlCwbvnZfaBsmusQlrdga8TBQaG3pB+U69tB+eV1MO5YCKZCfYPaRiSABJweHphdALHRwx+nW8Ah6BedViMJEsI1xPTWI+BM9Uz01FdJdneCU1JIN1yiKwJO34NFU8DZYeQDM/rBdGYTKKfWgLJmJhgnNPLO+mJYZHzWyFOc+Du6W+CEaUScoSmmS4r5fH688n94Dxi+fAiML90HxpZaqSyIOBNwyjVWEV/bYcub4Mxi+bwjoDWKVi+mihJQ8OXmsf1qS65GGBHDDw46LUuIs2lERLArgGjTwirgEOPkVt55XbwmZNgWOPbgwxGLGIfeMqBJZg4oL52U4/dT9AqzQJhGRHnyABcrUp74mGFb4OwYX1wD+BJonNTsdC5QZFgBZwd/DrD70NjXAYYfHweFgS3jYrrpZgwJuLgYM/xqTyXU5wwff8ALuMRjtyDlqXe4O+W5D9TtI6+q2x/8HCzVk8HSNlM6zpeI6a1HwPFpJUr1zdk1GsS5gezxtoCzoleY6Q3nz+gWcC60wIk2LXjlXV0ByjNHQHmNlYFy7X5YooDD1hwDE02m1CFxguhtvRIxvPMAH1QgntcpsUn8kxEX9kmDYgwHJWyYzVtph5sz0bhG+9OpFb3/wdUWOCv3vqE915YzAWdsqwPDzZ224+0ncx4VGdn807Z4Hn/E7S1wegWcm1vg+ACrWn31nrfRK+BCsvWVd90CTuMFCCdIx1Z5vvJJmGuiZywJuJaCZLDEyt2KRDQHMYhredqv4RmdVg3xqeV+Q8p7f8e3yU+8YbMl9CyB+PxGSHnjW0jcfxkskxdKx/kSMb11DWL4xSVpXiDsr4b9iLBFQVnaLx3jjI0dmfBPx6vhT2dq4c/31cLpZ5bDu7d64W8vtsJvLrTCd+da4MXddbB5RhlEpd/5NCIi/MbVsIuMzyyRbFqMx1YfDXsg4a5BDFb05kVort0cUAwjTiGA/daubnMoM1YBp2ydq/Zhy8mV4kL0DgDQAltbsW+XWF5FDK+fBWXbAul4e4xTWvj/UFZMdzwWJ0fWCG+P3v8Qkl0m2bQYl5gu2XDGffF/aQ1iUNbOBOP6mQ7H6i0DI4GfsXAKIvGc/sRYGMRgeOu82mKlkQf+gNNBDAIh2aWSTQv+MqphF+EvQBp2TiK7hwe61MFe+GKZO0z/Oys+EXCjG8TgLgJfwP34Q0jYelp1v/gJJB29obqf/wiSH3kFLJ1zwdI+SzrOl4jprUvA4US+Tx2y7fOlfV44AcreJWDqbeMCzz58SFgcNOQmwTtbyuH3x2tgT3c2BIXK8eLcZcbGavkGsgMFXF1NDrxxsAFe2lMP6XnaE/tKE/k6QbeAw75tGnYRvULPn/GZgLOfxFOLjCxQcLTwzCmynwZ6xc9w4EhOnOfQoZziDPKv3AfGktGJdaMLD1C9/0G3gMMWQg27snORwwhRUcBhKwRvmRCO01sG9IIjVXHkslQ3+AG6BZzeFjgvCjhTTg4faCKmt78hvsQ5Q295d4uA0wJb2NmLJbbQGbcvgHE4KMI+zQNMwJVmJEJGggVykuQyNKUsBZ5YUgRH+obvGhDwAi4QEdNbl4B7dC8oVxxbRYbj9uJCCA2X7Q5EWdR5gsQbRUBsgWtryINXDzTA09tqIS5j6OGkVzToFnA6hRm1wMnozQu9lXdQqnaLm4he8TMSyq5F/O1beWSPOnDlwDIpjKfQ+x/0PtC0WuCsGFfP5AN48H60Cji+3BFOcYKjCTWO0VsGXEG5vgNMPa1yHeFjdAs4P2uBU/YuBuWQ98rsneCXLXA6MPa1g/LYPnVgT2udpkjyNK4IONP4GA7u49QhfzlbB6+sL4VNE+QyXpWVyL+ULW8efmlCJwJO7v+GfQLQLyq5TBIkhGuI6a1HwGFLm+GlU5J91ISZwfDBFemm0GK4pbQ2zSiFv77QClfXVkNSufZM3yIhOfoqDN0tcDrD+TN8FKqGXUTvwzusQKeAw/4vGnaRoDRtMSEy3DJUgYLe/8D7BGnYRcQXIBFsiVOeOQzj58/kUzYoR1dKYezRWwZcxTjQCaaJTXJd4UP0CjP3t8CNvg+ccmINGMsDp04asRV+EL0vLLpegBJTIbqgEiLT0iE6Y5D0dN5lB20RqekQnpoGYUiKDuorIPjmTv5VanxLDYRHxHmFyJgkyaZJpNyf7T/P18Evd1TAO1vkspaeYIHq7JFbxTUHMUSm1zsKuKi0QQGn+ltKaB640TLaeeDwDVm03Qn42UTsQOoMvYMYpvU0waObauF3V9vhzcONcGxxBbQ25kFwsmM4GsQgo3sQg84RiPoHMdRINi24gNOwi4ijUGMzMyC3OBua6/Ng6oRCWNRTDFtmlsHeeeVwcGEFHFtSwcsJcpRxiNkOzC+HfYw9LMzuud5n78Ja2MW2O+aUw9ZZ5bCZXS++qGwcKIUNA+oW7fsXN8DJpZVweU0N3N5SCz/aXQ8/298Abx9tgk9PN8NX97fyl5vfXmqD/3Glnd8Xv7/WAb+/qoL7aP9H5HI7fPZgD/zD5TYdtGvY3MMTzy6GiW8fgX+/v84/OFcv27RwIdx/nKuD/8O2/3m+Hv7rQj38N+P/IhfVffT7C+OPp2vhH4/VwHcHqvh8XG9tKoOX15bCk0uL4NrcAjgzPQ9OTi+AC7MK4OGFhXB+SyOEfn4dnj/dCe8da4LPTrfA16wM/O0DbTx//+eVwfwfLAOY/2jjZeCyipgf3kHvedt5WUb+nvF37H/hf7Pn7x9Qw/3zjQ7uj/fBS/sa4JHNtXB2ZRXsZvf08r5imNlVCFO7a2FKWwF0txbA5FZ1i6AN6WkrhF6kXS9FfJs2rQViv7wB0/dOhRnVaR5lZl22ZNNierW+yY1dRVPAEd5HzBh7lB0LQTm1VrKPFuxALT54h0OvgBtuFGpUegYk5mRCfU0u7FvSAL9gFdz/ut7BK63fXGyDb861wq/PtvCH4F728J4xsRDK6twn9CLY+Wurc2E6i3fTzFK4uLoKnt5eB28faYIvz6oV7bfsGr47rz50Ebwue/76AqL6fS+Ax4l8j/DwauVmfZD//lo7/BPjizOt8BP2wH9oYw3ct7KWC5gjiyrhMOPYkko4tayKVXqVcGFVFVxk3LeiEk4sq4adc8pg1dQS6GkvgMqqXEjNy4IklrbxWZlcMEWz/xpXUg/hafgWm87eYofAfQ6+5TLiimv4diSisvP5Ft+OOewcmKdDqOGic4shNCWdi/ZxGvkQCHhyGpHh0Cu69Yr4OwGnmfHFAAflkb18OiM+QXFWDozPLVcn7P7oGhjb66XwVkaaRsTEMDx5AJSPb6jrgjbXSGHscWkakdA4PiLalJ4lpWMgoHsUqs5R17pHoep8kdeNdTS6PWUlfOCSsbtFyjt34KlRqHohAecniBljD+8P9NQhMM6ZLPm5RBiraL56WC7kI+AOAWeP3hsXhVlWYRbMnVzIBdfHJ5vht5eHRBAKQHzT+wcmjP6ZuVEU/c+r+DbZDn/HbD/YVgcbZ5RCY62+1iNfMlZb4AIREnCD1FSo/W61Bj9pgeFwlQC72fZ1gSPpX7lPHW0oXIP9y5mxkAm5rx9h4eXPls4EnCmGxf3VQ+pC7omOYuXeHx0Dw/e3YZzG5y1dAi42kb0MPwTKvqXSdQcSY1rAWcFVf148qc51ivNe3ukqMFhmoiwQHCMMtnKG5wSc3B+L8D5ixugBlyfByhLn7uLLlGiEsYGV5If6+ryJjEty3gfOHhqFOnp8NohBZ/8Xbw9i8CV6/4O7+sBZ0ZtnesuAuzC8fBoUXIcZRwZb1/RlblNVORMvS3i9gvNIKrf3gXJyDSjnNoEBxRGz4ZQzhlfO8HWB+Wh3nMg2mwnQwkIwLunjXwNwiSjxnFa07m1cUhBX/bCv36Q+cMnp6hJu62c7HKs1aAf7HBo+uAym2qFli5z1gcPrx9U0DB9eVVt1dNaN/oxWmmihuw+clwYxSKBQE21OMM6bAoZnj/DBQnwJssf2837mOA8dvrhgyx1ibKoB4/pZ6oo2H1zhZRnn9FPWzQLj/B6+kgSuSHHvR1f5oAqnc9d5U8CNj06XRqAS7iE8EdeUldNczBg94MzzOLTaxCpGXBooKNzClzyTSGWV5b5lfLTmaMAbV7RpEVnWLtm0CC9ulmxahBXWSzYt9IbzZ/AtWLRpgeJXtGkRUaovLyJKWiSbFljJizYtUISItkBD738IL2qUbJpklco2DSJK2ySbFnrLwFgAW/VFmxWc3Nz44hkIaWyBiORyCEkpgOCdTIy994AU1spI5d20aBoYHt4NyjuXeDzYaqNc3AzGtbMguLhSCq+3bvRnRkoTK3rLe2h+jWTTIryoSbLdEeyFX7J5GPFeDC6uYi8vx2Hc1T0Qwq7H+gwWB+N8sL0cfrG1HN5jvK+xmL1etAWchvAg3IeY3qMScDEJ/JMqf1PANS4rtIe9m7CZ/6enpTcQV3B3C4LuFjiNt28t8MYRbYGGz1rgdL59UwucjN4WieGmEbEnjD34RJsWesvAWEDPvc37yx1dy1tE8FOZ6G+P3ikz9I7i1ls3+jN608TfphGRcKEFzl04vRdx6btVA/wlwFRZKk0jsqAhHZ5dUQyvbijl04WIz229kIDzAWJ6j0rA6YAvfv3DI3LhchG9nwnoE+ro8ZmAo0+oEnr/w93yCdWX6L239dYVel9Y9NZleutGf0Zvmuh9YSEB54ixAb+QOU6035yfzClMTYCSdJ1zyWmgOYjBOn1IfceAzW1Pe88Ch/2mrlnQ2j3Ptn/43OMQHpsBO49dcwi35cBFvp08sBx2nbgBRy88wfc37jtvC7Nh7/0QGp0GR86rfrtZuJqWfpv/jiNXoaq5l7ubu2bD9iNXICQqlW+tYeYs2wEnLj/tcG4kggkljHvXsetQVDWBHxNlyeF+WUUNsPXQJekYTyCm90iDGEaL8tBuuTPnKPDlIAbRpoXecP4MDWLwH2gQg/+g997WG05vh33sliHatBiXHJgjT+3RmyYBPYjBQ+i/F704jYhVaDRNnAXVLX2wZsdpuHT7Fdh+WBVJJ688w8RQJhNb5yC3tBk27Lmf2w/c94gqUJh4Q6G0attJKG/o5raE9BLonb0GVrO4UHihDUXTjqNXYdvhyzZRGJOQx7eHzt3m29ScKsgpbuLuCHMWVDb2QE1rP6Tn1fLzHGEiELf2Amn+qj1w9ubzsPfULWifMh8qm3q4/dgDT/LrOnz+MSipmWi7XusxJbVdPDxeNwrAvacedIjXXYjp7QkBp5xYrVGIRgcJOM+jW8DpXMhcrxjQW3nrF3D6xI8/o38xex8JOJ1lYCzAW9Y07CJ66wC95V1vXaa3bvRn9KaJNxazvyNIwDkKOGylyi1tgf6562D55qNcrGUVNUJ5fTdMmbkSepggw3A9s1Y7CJSFa/bxbVxyIRdXi9Yd4PvTF2yCtNxqmLZgIxRWtHNb+5QFMGPxFu6XU9LMj8VWsXkr93D/zr7FkJxVYYvTklbCr2nhmv0QyQRdQ+cMCIvBQRdD52/rng9L1h/klDJRNmvpNh5HGLuWzMI6HiajQN1aScoqh4GFm3n4SdOXQ8OEGdDRs9AhjLsQ09sTAk4uQKNHbyWlt9IjASejW8DprDD0igFqgZPRK0L1PoDcLuB0loGxgN57W284vWKFWuBkqAVORv+96DEBJ/fHEgUH4V7E9PZEHzjxO/ydMNxSWvbo7TdCS2nJ0FJa/oPe/0B94DyP3nubCzgNu4je/l566zK9daM/o7cfrO4+cHr7kOrsC60bnYOF3AlvDdewSzARJz6j3cGwLXCEZxDT+05b4HBiQlzQ18EmvQGMHv9vgdP3mcWf0d0Chw9vDbuI3tYcvW/fulvgdH5+9Gf0/ge9LRJub4GjT6gSeusKveVdb12mt270Z/SmCX1CldF/Lzq2wL25sQwWN2ZIz3JX0WyBiy+fBpaKmYQHiCucJKX3nbbA4QK+xr2LJbu70FqwWYuIRO2pTETC4vMlmxbi3DnOCI29s/TzB8ZH6ZvROzhC34il8MQSyaZFuKVIsmmBLx6iTYuQmDuvlHyN3v8QZs6TbFoEhckz/WuhN8/0loGxgN57W29doX8xe311md660Z8J15kmoeZcyaZFSLS+z4Vh8fruH93gJNOizcPovReDhIl8by0ogHc2j37+NyuaAi4iPpfwEOHmHCm971TAeRq9lRQJuNFDAs5/0PsfSMB5Hr33tt66ggScDAm40aP3XhQFnLugT6g+QEzvO/2EShAEQRDE3QUJOB8gprc7BVwQewtJyS6X7CLZRQ2QmlMp2UUS0oohKUNfywCeW7SJlNZNgoKKNskuxoPTvITHDN/qExRm5vHFJoycfjhFjGgTiYxL4/GJdnuC2TnjknIho6CWn1/0tye7uAGi4zMhJGL4hZMxzmL2f0MinL/Nh0SqceD1YXjR30piRjFfVHyk/5FT3AgROv5vfnkbRFsy+fWJfvbgf8W4RooP/fNZ/qflDl/2EtKKIJOlcVh0suRnJa+sBeJT8iEqPmPY84ZGJfHybo1X9LeSU9LE05bHm+y8lRhH52PZxG2MRbuFCOPBModlOTh8+BY4a9oO9x/Gszjyy1u5G+N1Vlb4vVOr3mMYn7N7KCW7gufteBZPUfUEyd8K5ivWJ3hvpA1TX+D58L7A9C2s6pD8reD1ZBXV8/QZLm+xjCSmF0NhZQc/t+hvhf9HFg+mobP48FzWtI2IHb6l2z4vnJUVvJ+t9+FweRYWncTrMet9MT5cO8/S8qr4DA+YNtY81gJnX0hl+WZmZR7TRfS3B8+N8WJai372YN5a6xZn4L2A11Zc3TlsXYZ1Im7xP2B5Ff2tYJrweFOc32M8XC2mWTxPu8g45616WH7xPhwuLxD0x2vErbNnFdpzWT2Az5SswjrJ3wqmB54Tn6FYb4j+VvBc5uQ8ng/JWXf+yVRkRAG3eP1BSYCIiGGsU35oYUkthmq7iXnvRsT0dqeAQ5omzYGZy/ewCjVH8rOCle2Mpbtg9qoDUFDZLvlbwcpzxrLdMHf1QahpnSr5W2mePJ8/qLpmrIbcsmbJH8EKr6Z9OvTN3zxYsLVv4NK6Liir74byhinsYTDB6c2GDLD/gA9cDC/6WcEbaMqc9fxGK2vodvpQm75kB0SZ0/n/HS4+fLjgA2vRxhPsmJ1OxWHP3A2Qnl/DK6rK5j7J3wpWiviwKKufDN2z1w37wG/vW8IfMnUdA5pCrqZtGn/w9c3fwisg/L9aD63eeZt42mJa4/8trZsshUFmrdgLS7echvoJM6GhcxY0TpwjhUGmLtzKBG0ctPcuhtkr90NpvXZlumzbfSzOffycc1YfgNr2ASkMUt7Yw8vJvLWHWXz7eJ0hholmFejA0p0sH47zfdxWaYVjIrp37kY1XlamML+w/EvhWHyVTb1csGK8C9YfZWndKYULj01h6beRP2Bauufz/1LZ3OsQBtMcK/csJoAwThRKHf1L+TRG9uHQjvdCbGIOzyssqxge9x3Oycps57Tl/HwlLDxel9Z9iw+6rEL1oY3Xhf83r0wWBZbUQpg8cy0ksLIyddE2Xq4qmhz/AxJlzoD5647wst7P8nj2qv28jInhCira+T02k5UXvIcWbDgG1RrhwmNSeX6i25ycy8u7lvBKz6tmZWobf5D2sLzDvBBfOLH8t/UsYvfCTKhl9wOmSfestVLZw/gx3TBf8d6NSchi5W46TwP7cJgX+B/wQVvC7gssS2p94Xj/hLEXggn9y1j53MTFQyJ7wdW6f7DunMTqQ3RjXmB6o+jXCof3Al4/1tvTWH7g9YnhUHxgOixkaYt5ivdGtUadjHmJ5ae9dxGPs2/BFs06qmtgNTRMnM3dWMc2dc2VwmDdxV9oUgvAklIAjSzMLJZ/WK7sw2G6WtIKeTw4vyumYfPkeTZRZ4uP1fmY5/EsLozXKqjEMlBS08X+3yEuVLG+Q1GIeSGKYLynMI3x3se04HlRL+cF1sVYl6Eb6wJMR626oo3VX/0Lt0DLlAX8f2LZ16rzsksa+b2M+VrP6kXMN7EOQDANSmoncoHeOW0FP6/1/nQHIwq4tNwavsU51PacvAWzl23nc7OhbfG6A/yPpOWpYazgpLg4/xsqdutEvsjEqUv4duq8DZKoWbn1ON8u3XgYQmPSbHbMSIxr5dYTNhtW5klZFdA6eS6s330Wdh67zuJeavNftHY/nywYxSLu47xuVj/rnHHhcZmwef8F7l7H4sC30VXbTvDCF5uUD5MGVvCJh3EOPKycrMfXT5jBtzhPnDiBsBX8nzhhMLrxxhH9xfR2t4Br7JoD/eymTc+vlvysLNl8ij908QbAyk30tzJh6nIeBivT7lnrJH97UHhgnPigF/24P6tw8brwAYXhnL3hhEYm8ocKVgIYDltYxDBWiln5SM4s4+FFPytx7EGBggXjw8pRfDhawUoCz4diZdri7U6FI1ZWWAlZWKWG6YLpI4ZB8GGQzu4NPB+KQ9Hf/rwoRLFCwf+BDxgxjBV8iGK64XVqvTlXt07j143iB4Uc/l8tsWJNDzxfXccMp/8XKya8vv4F6nmnL9b+H+hf3zmTx4HpgUJODIMs3XqGX9uEqct42ZrmJF3wATFx+greUojXiA8/MQxWhpgOKGTw/F3TV2qWA8wHDIdufAigO4MJazEcPgRamSCwxjtpxhr+YmIfJo7lJVbsU+ZsYGm7nQtzLNPds9c7hEOBPcDEPZZ13A8Ow3tjmyREsQUE8wgfaLhFwTR10VaptQvzCK8JhSFu8cGK/1V88KHIw7xE4YOtZ9jSaf3v9mA+oB1fHPoWbOYvD3icGG4hSxMMh/Uj5lkHEwdaeTZt8TYuABo6Z0MvEzaYx4gYTr131LTC+xLj1rof8VpapyzkwgbD4DWKIgkf5nherGOns/D4kORiVCh7KVnlapokZvN7BsUwxim2nETEpfJrxvoG77OkzBL1/hGuD1svsbzhdaM/tgBq3T9F7PmH8aBIwZdVfCnE67UPg0xh6dHNyii++KLQwIe+1n2GcU2euYbXT/iChsdh2RPDIXhtKGywPGCaYL6JYRBrXY3Xjv8FW+7EMDGsLGH5nLlijxofK8ddA6ukcJFMuPN4WFpg3YNprCUw8T/gFssovrBgece6VAyHjQZox/+I4fB+E8s7gteEz2gu+Nn/1qoDEKzLcIv/EcsIlhkxDILnw+vGlwFskMD7WAyDZBbUcbFszQexDkB6WD2B9xj6N7F8xXpMK01Giy4Bh0tVoeDZfuQqE3A7oLN/MffDlRhwiw8p+2MWrN7LhRIqa3sBZ12qaup8RwGH8Wezihq3KIxQQFkF0JINh2xhrOGrWKWIE+7i8l0nLj8DWw4+AH1MaFn91+48w5fzQpGH+3OW73Q43/FLT/MMx1Uf8DqRntmrbdcaz4QfrtKw6/h1/l/wP1uPxeXF8Frw+JZJc2DV9pPcPmn6Mr7F66hlGRSXXOBwTnvE9Ha3gCMIgiAIYmyjOQpVXHzdH6hrmyrZAhUxvf19FCpBEARBEP5FwAi4sYSY3iTgCIIgCIJwBRJwPkBMbxJwBEEQBEG4wrACrrFzBmw+cAFWbDkG2w5dgoVr90H3zJUwsHgzVDf3QfeMlWBOKbSFVxeIT4YFq/ZCSFQKbNp/nu/vPHqNd+jE/mNrdpyC/nnrISmznB1bJImbuwExvUnAEQRBEAThCsMOYmiaOAvK6ibxQQFHLzzJBwvgFCE40GDu8p3cz75zfmZhPd9GxGVCpDmLd/Svbu2H1NxqPlBg7opdfIRqe88Ch+PuNsT0RhIqZxMEQbhMfEmfZCOI0RJf2i/ZCP9kWAHnSXBuFNF2tyCmN0EQBEEQhCsM+wmV8AxiehMEQRAEQbjCsAKusXMmVDf3wryVu+HU1Wd5X7a69mmSILHSwT+Nqm6cK23Ocpw/bch/zY7Twv4pm3vZxsMOfupcc6o7JjEPTlx+2rZf3dLnENaKeG3zVu7iM2Vb9/vnrufbLj7p71C43tlr+bZn1uqhsPNwXjn5HO5ATG+CIAiCIAhXGFbANUwYgKrmHi60zlx/DrYcuMhXK7D6L16330GY9Mxaxfu/oTsqPpsPgrD64WzZODv51PnrYfX2kzCwaDOPd++pB3lfO0sarpqQDNMW4CS/ydDcNYv3o7Mej4MpcJuaW8UEXC+fRbtl0mw4dO42bD98GbqmLYMJfYt4mLkrdnLBmZBews6zyRYHijmcIDg+dWjwBA6uQEE4Z/l2qGnVFobuRkzv4WjvWwqZxU3cXd02YLM3TJwLEWZsRlX3s0tbIbuklbvjkougpK4bGrvm8ePR1jJlEd8WVnfxbVp+PfcrqJoonXM4YlnceFx0Qj7fT8mpgdqOWZBe0MDtzd0LIbesnbut15uUXWU7vrp1Ot+W1E1hx83k7oqmfr5Ei3iukYiqngixi7ZC7ILNEH/wMkRWdYLl9MPcL2bGKohqmML3rZj3nFePa+yB+ENXVHdTH0RPnC3FrYe23iV8m1PaBvWdc7i7qHayzb+1ZzFEJ+bztKhhaYFbzLfskhbu38Dyxxq2mB2XnF3Nw0TG50JCRjk/tm7CLO7fNHmBdH49WNLLeJxYViqb+23lgV8by0PM/5TcWoiy5HI/LBcZRU3cHWXJ4+UmIj7HFl9br3p96M4obITimkk8LJa95lFeI0EQBOE6wwo4FEmb9p3nLVknrzwDO49d42u5iYJk7vJdfLtu1xkmkFLh+KUf8FGo63ffx+3W7Ua+ckMyF2a4DNc2Jrw27L2fHXcfX/VgkZ0gxIETKLZwKSscBHHmxo/YQyiTXw8Krq0HL0FsYh6/tu1HrvDlvSoauvlACVw5AUXc5v0XITWnCrr4El4sTnZ99teN5+bXvVO117TiGq3JTEyW8GtWV46QBdidIqb3cCzedAL6Fmzl7rzyDr6tbJkGbSjs2APUGg4f/im5NdyND//2/mXcXTsoAJC0gnousKz7M5fvlc43Ek2T5kNUQh53Wx/YeC24rRkUZDVtM/gWl3tJz2/ga65aj8clnHCL4gExp5baBIGrJL38Kd9aTj0CEWmlEI2CiAmVCCZaIrKquA39I7IqIfXj33GRh/sx01dCyrt/o8bx6q8h8cm3pLhHIqNATfsIcw5kMsGD58X9iuaptjBZxapQS86p5ltcuxC3lYNhcE1Q3KKAqp+oClhcDga3KIinLtrO40VRhcemsnDidYxEal4d36IAxKXQ0I3CC7eY7omZlVDERFhMYgF3lzX0QmlDD/dHG25xzUT7OPl1oX3GGr5dvOmkQ7wEQRCE5xlWwBGeQUzv4Vi44ThfWLu0fgrfT8ys4IvyohvXnLOGwzUDZ69SBQE+cHFtTXRbRZWVgSW7oLpdFVgzlu2RzjcSKFBautXWPGzFwW1OWRtvWarpUOPFlres4mbonb8ZWrEFx66lENfHQz9c688qJtt7l8C0RTukc41EwtXnIPEHb4Hl5EN8P7prLsTMUMVG8itfQMy8DdyNAi7lw3+EqHa19Q+Fn+X8E6pfdhVEogDTiH8krC1pKISxtRPdKKRx/Tt0F1R1sv0qm4DDhZFR0GIaoijDfMS0sAp0FFu4xiK605nYxjitaTR3zSHp/HpIzavl5zCnlvC1/dCNLXvYSoplCfMB1/5EsVZcq64TWlrfw8OhDVvosEXOGh/+5+K6bujoU18QzCnFfKFzbJnFfWtLL0EQBOFZfDYK9W5GTG+CIAiCIAhX0BZwUepC8oT7CTPj50c5zQmCIAiCIPSi+QmVIAiCIAiC8F80W+AIwp9IfOx1nxE9EUeXytdEEARBEL7EaQscTmuA26rW6dDRv9zWEb1rYA2YU4u5e+byPXwkG3aQxo7s9Z3qdAwT+pfxaQUqGvv5Poa3jmgjtAmOSCIIghgFiRo2ghgtVJ4CBacCDkepVbVM5wIuq6QF8irUKSxQyOGoNXNKCcQkFdgEHI6qswo4DG8doWcFR6uJ5yCGEBepJQiCIAiCcIZTAXcn4Fxhoo0YHjFjCIIgCIIgnEF94PwEMWMIgiAIgiCcQQLOTxAzxvzAD9TtqYcgpLAWwlr7IGr5Dggyp3N7WMc0iF5/UDqO+7VPhSBLFpjPP8H3g6KTILS6AyIXbOD7IeUtYHn0Fe6OXLyFbyPmrYOkn38Pwcl5fD9q5S4pXoIgCIIg9JPw0scQUlQHcacehMi5ayG8e67qF2Hh28g5a9gzux8iZq+G2EOXIOEnn0HcsesQs+mIFJeIpoBLqltISCyCn736Ovz2t7+Fi1duOfrV4mz5cjq6gpgxccdv8G1QTArfhrX0sky9BuFT1MyPYsIrYupiJs6SIbSyjTM+t9J2fJAlE8ZnFHN3SHE9O24ehNZ2qn7xGWB54nXujly8GeIffAkiZq2CxLe+4wIutKJFuh6CIAiCIFwkzAzR6w5wd/SGg7whJXrLUZs/CrjIZdvYM5+Jti3HIeHlTyCWPevRL3zSLFu44MQcKW4nAm4RIfD555/DX/7yFxu7jpxz8BfT0B5cMD0cFyi//rzkZ0XMGIIgCIIgCGdoDmJIrFlACPzylx/DH//4Rxubdh938BfT0J6Emy/yOcUSrv0YIvK0FyQXM4YgCIIgCMIZTgTcfEJg3/EL8Ic//IHzu9/9Dur6Nzj4i2noKmLGEARBEARBOENTwBHeR8wYgiAIgiAIZ5CA8xPEjNFDel61ZCMIgvAqoY77xsMr5DBewlhTAcZUdaQ+YopPlsNMaJBshAcJN8s2K+YkGBeljsYkXEdzEAPhfcSMsWd8eDy09y6G8oZuiI7P5LbsogaobZ8BPXM3DoWLziAIYowQVFsH46ZOlux+RWwGGD6+BsaXz/B95dmjYPj+NpiWz3IIpzxzFMZ1tsvHu5Hg/DJ+bgT3TZsWgPLFTQhOL7CFCWpsBMM3jzCRuVo63hnjalg+tLZIdk9j2r2Mp69oDxSCyipBefowGL58EAyf3YDguEwpzL1fPgT3fvUQBFuyJT/l2g5QfnhUst9tBIU5F7gk4PwEMWPsSUwvhurWqVBaPxlCIhK4La+8FWraB2DC1GUQFBoHQYN2f2d8jCpA/Z2w+ALJ5o+ExudLNn8kKCJJsvkl7F6SbD5CeeYwKK/cJ9k5ocO0angZ46HlYNwwW3V3t6gCLimNPXjiOWg3FRWAKSZROtadmCLiwfBrJhbev6zuFxeCgm77PI1LAgMTDKaeVpstKHyE62LxmnzQSqQcWemwH5ZQKIXxR4Ijh1o9TXl5avnYvVgKhyj3b2D/U7vF1lRfCabJnpvSKtScK9n8kZA4efoQKyTg/AQxY1yFBJx7IQHnXkjAjQJ2LaYIJ0LNjwScPaacXFDeOAem6ARHATehAUwpQ582/YkRBZyPMCWoc4BaCUQBhxindoBx3hQpnC9ItZsrdeLAGiipnQT5FW28O1LwYFm1B23z1x3hX8FwP7e0GapapkLjpDkQEZsKjV3qi4sD7L6NTxl6fkwcWAnZxQ1Q0dQDsRpzuY3ECAJO7o+FgiIhoxzS8hv4fn3nHIhJKuTu9r6ltnB1E2bZ3A0T50J2aSt3J2dXQ3RCPj8mJbcW4lKKWXwVGuchrIgZ4yok4NxLWIAIo9B4deUMf4cEnJvxVwHXVgeGt8/zlhd7AefP6TqigAuLG74fl4cwLu132A+zBMZLpSjgDM8eAcPlrVK4kTAVFGj2YRwtQWFmWLjhmG2/tKEHalqn8y9bKMrScobEnZW4pFxYuuU0mFOGngfhMSlgSS3kgkwMj0TGpTmcp659AAoq2yEtt4qdpx9iLK49710WcOaUEptga+tZAlMXboM5q/bz/fa+ZZBb1s7dE6evcjiubsJsvp00Yw0TcHncnVfewQRcEeQMijtCGzFjXCVocFkOf4cEnHshAedm/EhoGPctAeXBXZKd46cCzlhbAYZfXoVxycIn1NIitz6M3clIAs6UmcXEhPfrA1NLrcN+oAo4ZccCMM6aJIUbCeXKVlBOrpHsoyWYCbiYhKFnbXxmJYRGJXHQLzRKuxxgS5vVjeItypwB0ZZM3nVJjxjDc2LcGA92gRrv4rM6ZJgvdJoCLjWvjm+Tc6rBkl4GkfE5jFxui7LkQlp+HcQOCjyrHYlPK+Xb2ORCiDBnQ2quOmkthsd98TzEEGLGuAq1wLkXEnDuhQSc6xg+vAKGT9Ul9ST8VcBNm8CvGwWPg4DDz6eR8icqf2BEAWdOAlPS0EPcVwSqgDN2NvD+iGI47sdEqqm4SLJzIuI9ej+Gmp23bPkTLgs4wvuIGeMq1ALnXkjAuRcScK6jXNsOyosnJTvHTwUctrQpzx4BU3aOo4DDh7FGeLcjTGmih5EEnL8QqALO8Nl1MLx9QfMztHJ6HSib5kh2bzBGBJzcoT4yqdTj5Jc2QV5JA6Tl1Ul+gUYEu7HENHQVMWNchVrg3EvgDGIgAedW/EnA3d4Lhp9flOwcfxJw+GDGfmKD+8Y6tS+RQx84L2CKjAfDa2edi14njCTgTOXFvD+WaPc2gTqIwfD6/WD46ZlRiWtPMmZHoYoLububhRuO2haF/9Of/gTl3eukMIGGmIb2RGRVQWRJK0QWNUNM7xLJHxEzxlVIwLmXwBFwgdFSSALOdbD/m/LCccnO8SMBpzy8x6Gvkqm+im+9LuDSs8Dw3W0wfPuo5DccIwk4FKcmPygXgSrglP1LweijVrbhIAE3Sl5//XWbgEPOX7wihQk0xDQUiT98DRKuPw8R6WWSHyJmjKuQgHMvJODcCwk4N+NHAs5YWMCnD7Ht71vKt14XcFEWMLx6Fgy390l+wzGSgDNlZIEp2fdToASagDOlZYBxyzxQ9iwG5fRaKZyvGbsCrnahR3np5Vfgz3/+s40Hrj8shQk0xDS0J2bqcr5NfOJNiF26Q/JHxIxxFRJw7iVwBBx9QnUrfiTglEtbwPCoEzHiRwLOGd4WcKNlJAE3LibRJxP5GruawWS3H2gCjhNpAWXvEj8VcM6FkT8xgoCTO9Qn1sz3KGkNi+Bv//Zv4Q9/+AM8/vjjkn8gIqahq4gZ4yo0iMG90CAG90ICznVwiSrDF7ckO8dPBZypsAAMH10BU1ic4yCG7hYwWRwnpvUEOPmtKW4EQSbk8YgCzkcYl0112A/UQQzj0jPBWFYihfM1gSPgnDfwaAo4wvuIGeMqJODcCwk490ICznUMPzkNhl9ek+wcHwk4Y187mFLSJLvNf/UAGH51C0xNNQ4Czji52eMrMWArmfLCSY7oZyMxFQyvn+XTnVhtIwk4U6SZrywh2r1NoAo4U3u9JEb9ARJwhNsQM8ZVSMC5FxJw7iVQBRxOhyGF8RLKxU1geON+yc7xlYDbMpe3sol2m39tJRg+vMzFmoOAYw9xU7Tn6yhjQ7VtXjG+rNcT+22jH3F9VlwhwvCjY3xtVusxIwq49AxWDpw/RL1FoAo4vpZsaoYUzteMEQEn98civI+YMa5CfeDcCwk49xKwAq6tTg7jJXBFA8PXD0l2ji8EHEsb46k1YJrb7WDH1RdMaep9jcJNef4Yn1rEXsApx1Y5iCZPgRMIW1v6jL1toDxzGMZZ+6+xLU7KKx4zkoAzrp8FxgWO/9kXhFkCsA8cwsqCcRStr6aacjBObJTs7iJwBJzz6yQB5yeIGeMqJODcS+AMYggMoRmoAs54doPDHGfexDR9AhiePCjZOb4QcAj2Y7NPI5Y2yvMnQLmwie+bOhrA8PlNGBeX5NgHDudRixleKN0p2McOpxAxfPPwkF389Mn2De89AKbmWpttJAFnaq4BY7nv+3AF5CAGhikrG4xTWqVwvmbMjkIlvI+YMa5CAs69kIBzLwEr4FbPkMN4CRRCTuc085WAG8TUoM71xt0ocK2fKTOywPDZDT5vmoOAYw9wbwxiMHx0FQw/VufOw8/fOJLX6mfKzQVjYzUYvrgJxmmdNvuIAm5KGxi7miS7twk4AYctbxWlfCQqlgsxnK8hAUc4ENLYBH/18Ca499oametr4a9ub4Ww7BLpOETMGFchAedeSMC5l0AVcL6c/8vw64fg3u/8T8ChOMNPoqLdiqIxD5wJH+IaYd2JKSGVr8Rg+NkZvm/cPBeU5446LOHE+8D94hIoB5fZbCMKuMxsMKX7vt4KOAEXguKeibhl00DZvVgK52vGiICTO9TnlbXatuaUYu7OLGyQwiG4SH1MYj53p+Wpi9ffrdx7cz3ce2mVIzfWg+HLh2z81aNbpeMQMWNchQSce6E+cO4lUAWccmSFHMZL8Elpf/WgZOf4UMBxwpyf39jbzre+mAfOlJcLpsTBlj6Wl1Ln+bA4MDx10GFQwogCDvvVZd55HX2nBOogBuNAJxi3zZPC+ZrA6QPnvIFHU8Bhi1BCRjlUN/fbbJNnrOTbpq7Z0DBhBndXt/RDlCUX4lKKoKN3IWQVNbLjyniYisYejXjHNvc+sFLmk2vsTfpBG/deXycdh4gZ4yo0CtW9kIBzL4Eq4HSt32gWOm27CRQa2Fok2jm+FnBOwE9lykO7eLr5QsDpyS/jnMlDAxtCdAi4nByvDMCQiHO8ZwJRwKGYRrFsbG+QwvmaMSvgsFUto6DeJuDW7T4Lnf1LoKR2EqTn13EbijV0o4DLZO6Cyg5u37j3HN9uPfiAFO9YRxJvyLP7HAXc5VXScYiYMa5CAs69kIBzL4Eq4ExLRp6/arhpNe4Ew7sPgOGzm5Kd4wsBx8SR8fAKMHU775BuXNoH9356g3dc97aAw9Y2BT+PvntR8rOFwT56r58FZd1Mm21EAVdXAabqcsnuaYwLexz2A1HA4edr5fH9oDymvaII/zQd75kXoJEYswJOL8nZVZLtbsbw5H75EyryowNw78dX4N4HN/K3U/E4RMwYV6FPqO6FBJx7CVgB19Mmh/ESxsktoOxaKNk5vhBwDL6igvhZ0g6csPXej68zAZfjfQGXks4/ORs+vyH52WOc2MTnJrPujyTg/IWAFHAM5b51oJxdL4Xjfo/sAeXmTu2WU7E13M2MEQEnd6gnRk9w/yS495OrYPjyQQfu/eVlCGlqksJbETPGVUjAuRcaxOBeAlbAVVfIYbyEcmYdGJgYEu0cHwm4keAi6oubPB29LuDikkD5+Boo7z0g+XH/3FwwFTkOBDAlpoJx5xIprD24DJQx3/f3WSAOYkCUR/aC8uAuKRyCLwOmkmLJzo976hAozx6W7O5ijAxikMUE4X3EjHEVEnDuhQScewlUAedL+MCn729Ldo6PBJyxuQZMsc5brPCzn+G7R8GUl+99AYef6350FJQnD6j7CSmgbJwjhZMoLZNt9vEWFvh0RQ4rgSrgRotybqNHBxGRgCPchpgxrkICzr2QgHMvASvghI7k3sTw9GF1UlwNP58JuPWzwFTsKCSULfNs/bWMRYVg+OIWjItUxZtVwCmrp4Mp1bP3Ps5HZ/jBAVBOrOb7xvlT+CTD9tOIaDHSJ1RTfRUYJ7VIdm8TqALOVF4CxlF0RVDu3wDK+Y2S3V2MEQEn98civI+YMa5CAs69UB849xKoAs6E/aXEMF7C8PE1MHxtt6qAPT4ScFoo17bbRNO4CDMYnjrE3fYCztjfoa7ioHG8u8DPcbwPHApIq02HAB9RwKVn8pGoot3bBGofuNGC/easK3x4gsDpA+f8OknA+QlixrgKjUJ1LyTg3EugCjhfYnjhhNqfTMPPnwQcX2psMN2UXYvA8P5lvpC8g4DDT68JHhZwsYlg+OQ6P7/oNxwjCThjds6wAze8RaAKuOBQFTGcjeH8PEjgCDjnX+hIwPkJYsa4Cgk490ICzr2QgHMdHNHp9BOSjwQcn9Q2JgGUg8slP8Tw3BEw/OoWGLtbhBa4djAlp0nh3QleF5965c1zkt9wjCTg+OTA/rAWaoAKuAtne+Hm0QlSOER5435QfnLaYVSwtyABR7gNMWNchQSceyEB514CVcDhKEUpjJfAPlwGfLhp+PlEwLG0MZ5YDabZk5zOfadsnscFHKabg4Cb2ASmNM+3YhkX9ICxpVayD8dIAs7Yi2uhNkt2bxOoAs74zgVQXj+rttQKYY3LpwKmr2j3BmNEwMkd6gnvI2aMq1AfOPcSOIMYSMC5FUHAGed2y2G8BA4OMDx3TLJzfCHgQtT+YMMNCjAcXs777Zna6x0EHI7iNNmtfuBPjCjgultcFoWeIGAHMWDej2KyXt73sHr4EcJ3whgZxCCLCWTqrOU2RD/C/YgZ4yok4NxL4Ai4wGgpDFgBt9W3aziakpx8dvSFgMMWuJNrwIRrnTr55MUXi//0OoyLTXRsgZvRxVdnEMO7FRyF+vBuUPYulf1CVCFhFEbQIkFRyXywgyk5XfLjxyWkgMns+/IbqAJuWHzYZWFMC7jla3dB55S5fCv6zVu1F+raByA+tQTOPfQiVDb12fyWbjzMt5ce+xnEp5Vyd+8cXP8zG05d+//Ze6/wOI4rYfvm00w3A4gMDAY555wzSQQCJAEGkGDOOeecc86kKImkuDIlK2crWJYty5KsYFmyJecNTrvOa6937Q3/xfn7VKNnuqu6AQxQAKahunif6akOGHQNZl6cqnPqSfJY0zyLPK7ecRqyihvJ9vi2hZ5rLF6vXuOLBN0xviIEji9C4PhiH4FzkblU2nOpcwJ7zCAhTW0Ax9P+FYFDsFwHipzneW62R85IHbiPHySyZBC4ipIBj8DJ7nhwfPsGmQdH77MkPgmk3UvUqKLV60PJGELR0BiOAud47axat8/s/ga6uq052F+GtcB1x9yVu2FS52oicEcu3TPsS8yqhMi4XLh45yVP2+RZa8jjietPkMfqpk7yuGDNPjj/0PNke+2uM7Bx30XmZ31RoDvGV4TA8cU+AieGULkSGQdydannubR6BnvMIOHctwTus1hVYCgFDnFq92VMBKmW77yxlTyXOlvA8fnDzBw4ubFm4AWuIK9rKS1dGZFuhns17PLetKvAYRRZGlfJHIdIy6ZZzy/EvoscSIGzFiN/ogeBYyfUI4nppR7ofQL+0B3jKyKJgS8iiYEvdvmSpCMB8oQa9phBAheFv08RErqdMIQCJys4Dyz1PsdEj645TlgDzvHJQ2QNWUMEbu1MspA8fS2eyCmp5GdjEgU+x8nxJCM1uPt71dMcOHJ+kEmEaJCxaxLDiNgEkOvLmeOGGvsInHWAx1LgBIML3TG+IiJwfBECxxe7CtxQIscngnP5VKadMEQCh5mxhnIgGIG7t99T7kQqLSS12OQxxrVQpdkTB17gAtRooEOLBs5pBccrZwxJF1JrHRE850GvgPYkcFJ7A0gN1Uz7YGNXgcMEBuf4KuY4QkTMkC1TJgROwA26Y3xFROD4IgSOL0LgfMf56H5wfHQ/004YCoFTZE06sBTkOmM0RZrR5FlqSk5OAcc7V0lCgV7gBgWl75wP7iBLMGltZNhWXyhWee54/SzI+d7hSCJwWOLCYrhVLsoDqbyIaR9o5Naxhud2Ezg5PxecR1eCdGgZOE+vZY7TQNmn2waDYStwEWn1ggGEvt98BE5E4HgiBI4vdhU4eZLxS3Qwcbx2jszpotsJQyFwAWqUi25zbp1H6nnhtuPuHrWMSPt44xy40kIYETaw/2TKIVHgfOowOB87YGh3PqG0PX3MexzOx9LVJEOBIwvWV5Yw1yQo0jeQk+mtkLbOJQkj2vNAt73mwMnF+eC8tgUk5W9IWyuXRo5PsqwpONDYR+CsX2efkhgE/KE7xleEwPHFPkkM9hBN2wpcSv//NvuK8/o2cHx6i2knDJHAmUGiXkdWqNuHl4Pjh3dJ0oJB4JJTe5VQ0F+cOxaANHeSse3Lh8D5+GGyTSKE37gEzg2zPft7GkKVc3OGTDL02DKJAUvPNFaDNNV8JQb1GJM2Bbm8qPvz+skXNgtVwB+6Y3xFCBxfhMDxxa4C55xvHjnQI5vUFuOB492rigw9zLQT/Ejg9EjjqkjUEOumMXXgogd2VQssZYL3y/ED9Z5JKzvA+exxY3kQHAZe3A5ymPfzsieBsxKMgUaOM94v2wmcct/krEwS2ZRmtjDHIc6Ta8B5VJX/wUYInIAbdMf4ihA4vgiB44tdBU6a1/NKDHJ5MXMeDxxvXgDH53eYdoKfChwiR6mL1usFznlkJcglBcyxvHF2toJcq87Rw3VbnfeMw6lm9ChwQ4S0a6FhfpjdBE7qaAbn7d3g+PAmOL5x2VSEMWLr3LmQaUfk8JgBXT93mAgcOx9LMPjQHaMnMCwOiqonQkFlC4zuSlYYHRRFCihXNc0kz4XA8UXMgeOLbQWOGo4bTBzPHiNROLqdMBQCh8Nhyheu3MuMTMMQKq6DGjSICQ0myEnJIGewX9qeJAaL1SWGCmnFdMOcQ7slMSByZAz5G/LUDaTA/sBl1+h2RFLarebO8cA+c+CsAzzdClxx3VTyWFI3DSbNWgdhMdnkeWXjLAh1Z0JYdBZzbFENrsqgPNZOgZL6aWQ7JbfWcNz49qVkOzGzCuLTy5mf2xfwNWmPSdk1UDZ+BgRHpZPXkVc5UfkdpkJ6wThyjPZaY1JLyGOw0pGpuXWe8xuU15dT2kye4+8+vn2J55zGqcuZn80DumP0hLqSIbtkPETFZxOZw7b88maoapwJaXnVROaIwOGXj58TEJHKtPkj5MPSpN3fIBE4k3Z/Y2RIPNPml4Qq//Vne/teLikkFeGZ4wYBUgfue7eZdgKKEd02CMip6UR0nFvnM/s8xySmkMeRQW5F4DALVGlrrCZFkuljhxzltUo7FpMyIViEmNmvgEOxEg6lm+wbUMJjDM9JEgN9jB8yKrT3f+v4fpKry5j2wWBMVAbT5o8EdCOalgKnLoPlfT55NgqcKmzupCLyGBadyZxX1aSKFNI0bTkRvajEQsMxWSWNUDZ2OnNufylVhLGioRNaO9dA6bgOIluFte2QV9FK9qcVjDUcH5NSDLGppYrApUFhdRu4EvLI+TXNczzH1EyYq0hpG/OzeEN3jK+IMiJ8ERE4vtgmAhfiJkNvnudYowo/SOnjBgHnnd3geO86004YqgjckRUgtY8Hx1fPsfu7cDywgzwa5sCtnqFG4UyO50awC5w3toHz2CpDO9Yhw7VOmeM1MnPInD2r4Tp5RjNgUWC6fbCxWwQOl1iT1ncy+/Vg5rAcP8DvCwuGfQSOFzEpaqSrtJ6VtiqdLPkj7iSjfCJp+ealQPoD3TG+IoZQ+SIEji92ETicvyU39W6IcKBxvHLa/8qIZGaStWKdt3Yy+8j+glyymD2W3aCzUEkk0+QcbgS5yJw3Z5dAamAJEZLMQB/fRY9z4MKiDUkPQ4XdBA6LPjsf2qH+TVmVaBlChonAsRPqBYMP3TG+IgSOLyKJgS92ETjP0EXXc7mp1nqRcyQwkiwbZVUEtj/gdZ0vnmDaCUMkcBo4t4lu03DuXUweB72QL4Jz2aiIqfP+7eC8vJk9toueBI7IW8gg/x4m2C2JgaD0hbxlLow4YYyK+gPDJImBlYnI3InkC2x0SLx/EpoA4RmNEKR0gP51R2Q1kX3M8X5CcHwpBMfkM/dbCJz/YR+BExE4rlBf/lLD0K2F6vjoJjg+u820E4Za4GLNhxultvFk2FeOjjdG4LCEiK4o7WAgzZwAjqePkuWa6H16iMBR4q7HuXcJSIumMO2DjR0FDgv15ibGwLgy30eZsCwMWWfXZB8Phq3A0eLhr4Sl4lCm+ppDEyuY/X6JIpj0/RYC53/YR+BEBI4rwW5D8V65bPCXUNJwPnecrGpAtxOGUOBwdQBcIoluR5wrpyvSeYd8+RoErqqUDL3Sxw8kWHvOict69bACBFmJobqUrONK70NIceB1nUz7YGNLgXOrJWWswKF1aWwl0444j68G58HlTDsvhonAsfOxRisdYA/iPa/Zld9ust8/oe+3mAPnf4g5cHyxjcBhEkOWf/T9fe9cA8f3bjHthCEUOEQ6sMyzTVZZ0BIAwqLB8fYVsj0UQ6ik9ERXEgqWqMCkBqvImgYROKz6X5DL7CPXGVsBcvHA17DrCbstpUWKJscmqEPQLou/f5yCYLFPWjIFnGvVMlkDgX3mwFm/zh4FrrS62bO9ZtMeSMkqhTOXHiDPDx6/SB637j4Kcxevg+jEXNi+5xhpu3zjLnk8d+UWxKUUwKRp86CucQokpBXCqQv3M1LTV7TXHEUJ3KUbD5PHC9dugzshB+Yv3QCRsZmQU1QHJ85eh+TMEjh3+SFyzHHlOT7u3H8SpnYugSWrtsLmHYeYn8UL+n7zEbju/8v0F4TA8UUIHGd6+LIfTBzfeQAcnzzItBOGSOCk5dPURIVnvWuLOu/tB+cVdY6Zc8V0uO+Th0gm72ALnJyQTJbJcnz9oreth+FTpKc5cI0dFVDZVs60DzT0a7dbEoNTkXznk0dIUgnOQ6SPQ1Cypboyph1ZdGEudNwauFUa7CNw1iN0PQqcxr0nX4TDxy+R7dYpcyAoIolsR8RkwPWH7sH1B+/B3sNn4eadL8OKNdvhxdfegoq6Vrhw9TZcu/kIfOWNb8GP/vHX8PJX34YH7jzOXL+vWAnc86983bM9a8EquHL/P8Crb74LP/jpL+HGrUfh9iNPwcXrdxShqyWvd/6S9XD1gUfg3uMvwrlLD5Lfg/5ZvKDvtxA4/0MIHF9sI3CYMacb0sGitXJ3SQwDiOPjBxWB868sVGnjbLI8kvPl0952TODomt8mzWqB+3AprfgkYxmRaY1kXhx9Pd44pzeBVJRHtqVZreB89ADILuOkeseZtYY+7UngJCwj0j74ZUSkzXMNmbt2EzhCVBw4njoCjicOkYic4VjluePDG+DAYW6TJJHI8EiICBu4f6i+EAIXGJ5I+Pj7P4W4lHzIyKuCSdPmQ0BIPLz59ocwJjSeROLuf+hR2HPoDOw+eBqWrtxCzimvbSGih/KEAvfDn/0KXnr9m1Bc0chITV8xE7gA5TW98Oo3yPbTL3wVxoQlEIl85WvvwOc/+QXkFtfDQw8/QV5bdmEtidDNW7QWNmw7AI8+8RKcv3ILzl5+kPlZvKDvtxA4/0MIHF9sI3D+FIH72gUicXQ74nz+JDiet8hQHSiwDtyxlSDPmMDu60KOiQfH62qNOMMcuKGQYJyrt8SYfCDXlSv39Tw4V3Z42kZGdT9RXlrYRiSObh9sbClwSEQ0qcVHH4dIa2eC1DQ0iULDRODYCfXMxHs/RnvNUQVTmX3+Cn2/RRKD/2GfJAYhcFzpg8CRGmcm7f0l8Z0LkPLhZaYdcSry5njpFNM+JGD0rWu4z7lnsZp4QUXg/IZAFzgf2Qcjugr7SsX5IO1ZCnJGJqlxxxyvkLe0BbInmU+0H0zsmMTgzwyTJAZWJmjh8FcCwpI9rzkydxKz31+h77cQOP9DROD4YleBI0OoJsM7nv2uWJDOb+ixVEVf+PmFOvjV9fFMO2GIhlB7Qlo2TRG4OyTi4pcCZwJJYlCEE6H3IbVNBVBcPvR/Z7ZLYtDAodPuSshY/NMkh7hBwvIzJvt4YJ8InPXrtLXARWQ2eV5zcEwBs98fCYkvZe63EDj/wz4ROHuIpl0FbijJrM6DjP3zmHbCUAgcDqGeXE2GUJ0vqtG/UcqX88e7i+GRxWoGp/PICrjv01uk8r6dBI5u0zN1kiJwFX38Owt1qwkeuK4pvc9H7BqBc17cZJnEIFWXAdYOpNsHg2EbgcNisxHZEyAqf4pfgiVDsO4b/bpDkyqVfW3M8f6CWrcunXndQuD8D/sI3NBHBnrDcBU4WTlenlBLFnin9/UXuaUewi6sZdoJQyFwCnJ9JZnn5ry+lTxHgftkTwk8vFAVOIxWOt66RLZtJXC6RAwauTgf5My+CZycmALOJw+DnGcuX9LuxezkfgtsK3CPHgCHhcA5dy8C5/GhWaVhmETg2An1gsGH7hhfEUkMfBFDqHwZrgKnnmPSxgHnxtkgfdvPFrM/vAIkXDpM1x4WGgmjA9VtOT2DJAngkPJACxyPwsCyIt7y4qlqpumkscx+HnSXfeupn9cL7JbEkBgVBYuqE8Hx4E5wXtrEHIc4dy4E5+oZTDsKdYDynkKYfZywj8BZB3iEwPkJdMf4iojA8UUIHF/sKnBySSGJsjHHDQLSgskgPWexCHuk8iVpspzVSIVP95bA+zuKmX08kClZDQiKhB9fGQ/vHVMzCckqDSdXk21DFqoiR7yXRcLVHug2MxxvXgDHG+eZdo2RiemKeCrkmRfyDZhUD6NL/aGQr70EDtfLleZMVN7HbWRZM/o4xLlqOrtPeY/hCg7Jj+6CFAX6HF4IgRNwg+4YXxEROL4IgeOLbQROESO5pszzXM7JshxaI2Al+cpiRvx4MCotDZJOLGXaEcdXToPjFfMs1L0T0+DU9IF9X4SGdP2+yu/fcG8TZJ9cQp7LsQngeO0M2TbUgWupsywlwQv80sdCvjhkp293fOsqqTWG9eDkeBPpxSQGjMRZRPQ2rh8Li5fVMu2Djd0ErlfgyicWySMylh8ZwPIzQuAE3KA7xldEBI4vQuD4YhuBc8WD3OitSyUtnmIucIqwOa9uIRE65929MKKHNR/7QlSEC6oyzO8bLldFCqCa7BtI5K51RSvTva+LZOl2CazU3gCOT26R9UcNQ6g4x8zkejyRc3PU1Ss+uN/YjhmmcYlEIOUEVhZ6TGKYWwVN08qZ9oFGzjUKm+2yUJW/G6mqlNmvR64tA2liPdM+GNhH4Kxfp6nA5VW0QkxKMdkurGmD8Jhs5XkplI7rgNhUzKI0Hl9QNQkiYnMg1J1FnrfOXAMhURlk251URB7DorOgdGwHFFS3QV3rfEjNq2Ou80WG7hhfEQLHFyFwfLGNwFGRNGl+G3sMEhoFzhdOgtRaD9KitgFJYtg8pwjev2o+9CTXloM0pcHzfHZlkmce2oCBw6P4O6+eAXKaeVTAeXotWb9VLso3RuC2z1fOsf4i6g+YZEAeFVFzvnNNXcBe2xfsIsOnOIxKn0f2Z2WCtGEu0244BqV1APoXkTbMZto8++ZPMgxZ2y0Ch8upOferkVkrIsNckBQ9MPe2J+wjcOZ/a4hpFmp+5SQibLhdVDMF4jMqFCHLhLLxM0lbZFxel6ypx8enl5PH8Nhc8jhx1jrPvryKieQxLDobqifMVYRwCnnMKm5kfu4XGbpjfEUIHF/sk4VqD9G0jcAFukjmoPYcF9RmjtEI6RreMYvQcUBuqCJJA3Q7gUpiCAr2vobC5BioSo81RMZ4gfPEcGgr8PJGT1t9XgIkZiSTbcdTR8Hx2W2QFbk0CNyCNuW+qscMJBLW7evK+JTWdYLj01vgeP+6wg3mWILSdyMLi9h2HWT+3tgKpp0H0rQmps0K22Wh4t9SobqsmRWYpIBJMHQ7Eh0RBVnxA/e9NmzLiPAm2MWWzoghkTz22C8qdMf4ihA4vgiB44tdBE6OSzJIm1Q1MMkAvcHx3YfA8YO7TDvBIgsVkxj+frEK/nKuUk3AGKBVInKbSsgjfgH/7HAZvLtdvU+YqEBWYgig5sAtmmI518kUnBuVav3FpUcuVX7PyFimVIfz0HJwfP4wOJ49Bk6rZJCAnodQpbZxIOnWx/UZToJvO4FTwH5x7l0Czn3mcznNCAt1wcT8ePLecoWbv895MEwEjh3OEww+dMf4ihA4voghVL7YReBGhEWDnO+NGgxVjSok/IkDEPVt86W0rAQO+fXxckWqup97xJM9U7OhpVDNMMV5W47vPkgSAvpTRkTOzwVp2VSmvTvkqFgyL9Dx7FHyXNo4GxyvngE5IZnUrhsRFEX6lz6vVwKnSCLd3isSk8H52EGS5crs8xG7DaE67t9G+kN6/gSMfvKQT/MgRw9QaR49w2QIlZWJiNTaIaWlfS5MbO+E5smzmX3+SEicOs+vP9Ad4ytC4PgiBI4vthG4KExiqPY8l+dNIkv60Mdh1iKZD9ZQpQ4NDsAXzi8v18O/XbWoTdaNwP3xdAX86tjATLon0S79qgLKfXB84yI4Hj+k7o+IgfuwDlyAMQInt9QSwaKvxwUUM+UR+8HxvYfA8emD5DnOEXS8e50shyY11oBcVkiyYenzexI4Mgzdx6FojILe98kt5ed731N9RS9wcmr/vzMGCk8ELjoenFvngVxVCnK7+WoLrsYKSJllvg+LROunBvDGPgJn/TpNBS6mfN6QUd62Dn77298SfvOb38DuIxeYY/wR+h7qCU7I92yHjpvO7EfojvEVUUaEL0Lg+GIbgaOTGBZMZo9RwIntzudOQPi0cXB5Zz2ER/Qt0tQd5acWQvOr+5l2QjcC99r6AvjK2gGoW0YK+S5XV57wtKnLZ0mTvaLpPLmGPBoicJil20cJ6gmUSrIdGAmOu3vUpauU586V08Hx9lVwPn8cHIpsYxKFXMxG0noSOGl2C0jTG5n23iCNrSCZsdJUb8JJXzEInNuHUh2DjCZwKGDjc+JgTFgURKabf+5L4yvJvEW6HYkMd0FG3MB9r9lH4HyMwMWUzx8y1u04Ar///e89vP/++8wx/gh9D/UEp6mZuxFzN0LUmbvMfoTuGF8RETi+CIHji10FrlvCoyEoKhaOXJtFHpn9/UTqbIGg+9UlqxgogZOmN3mGqD7fXwIf7ux+Yn5fkWa3gpxk/BvGZAm5a9FxLHrsvKkum2SYAzd3kmfVAZzbNCaIvbYBVyxIJf2UUOzLxBRwfHADHB/dDyPwdUYa+0kOVdoWdpOoolCYHgfxMX37fJVqy8Hx8QMgj69i9vmK3YZQkYiwSIjsGA/J68yHw0k9w9fPkb6h9zn3LwXn0ZVMOy+GicCxE+pjKxcOGVv2nYG//OUvHj766CPmGH+EvodmRN94hmnToDvGV4TA8UUkMfDFNgLnTgC52VsHjmRy0sfokMOiSYkMXLSc3tdfHG9cIFmUdDuBjsB1TZQfOSYC/nS2Av7lSBl7Tn/BCNzJ1TByWgM8sVydJ4hJE9/eWwa3lnSV8kjPBMe719R9eoErLiTDzrj9bycrlNdYCYFB3cgyylaK9x9bplq/BfK4KpAKjJmPpIxI12tiUKRXXjSNbddxc1EebJzafTalFTjEjgInNXnfU31Fn8Qgd3fvhhi9wOH7Q05JA6nM/B+KK8da4PBZc7mTnjgC8letV9DoL8MkiYGVCVpOBpuvf+Mt+OUvfwmvvPoas88/WcDcQ1+hO8ZXhMDxxT4CJyJwXKEicM43L3ZbA0yOTQTHcydgRFcEiieOty+D89OHmHYCLXA6QkIivSsl8AQF7vhqMp9pR4v6mTVSEaBXb02Fk1fU9Swdt3eB4wcPgzzVWEZEL8If7CyGnx0q7fdEdWmp8YsfM26dH90k0Md2R09DqFhQOdSi1MVgYhA4XzJ6BxlN4DD6trg2GT5U+vuHB0rIPxf0sctX1EHHenM539CQAktrB+77YtgKnGDwoTvGV4TA8cU+AicicFyhBe7JIyAHWssSZjVKWCKhh0hdX6hIj4XH1ppHLrITYiAngf2bx4jHz4+VwWf71DIfvJFzckhxXOmIWp8Ov5R/eqYWvrld/XkYaXJ8fpuIbX+yUMkSZSYZo3qkSuPviJmv933/Njjeu84cS/ZnZKilRqg+7kngLq0shTUd/RzO5YA/lhEhZUKoYsT0UlputxvSMsyFE6OsMhUx1VhQlQQzytilz3gxTASOnY8lGHzojvEVIXB8EXPg+GIrgdNFCnC5LOaYQeLQzFz4yXk2axL5pyPl8JOD5qVCvn+lET48ZX4eF5T7E7xvEdnGiepYc+7TPd56ec61neTRIHAoY77UQ0tM7jFzU8Y5cjgE2jVXDpMUcBUIhD7Wg/I6MGtWHlfpaSNrobrjmbl9GkVV2ZCQa/0l2i3Kz3Pe2w8jOKwDq19KSy5Uh6yHGufh5WQem/4fGL3A4TC5XF4E0gzzKFtP4D8kdBsv7DMHzvp1igicn0B3jK8IgeOLfSJwQuC4EhlnWKJKLi3qVjwiwlxwfk0FhIf3MdLUDf91vhL+95L55PfE6GhItliC6OWHpsIL18yzZ3kR1NlMHnH5rr8qr/MH+1mZNAyh5ud65sD1BnlCHUjzJjLthmNyspi+kbOyPMkSkiKSzqePeWq/YbRIysgAx1uXDFmzKHDOBW0gzWplfgYyemMnmfdHt/cGXIzd+egB5X3V//e/X0bgFIGXUo3fX5rAYXS2LLXr9/ahBpzG5VlZcKh94KJkw0Tg2GiQYPChO8ZXRBkRvogIHF9sI3BYB86irIEVi1qyTOf39JdDbelwfoZF/3YzBy5ofiuELpzkeX6pMwvCOc7hwiFU5909nufPr8qH41O9X7TOm9vIoyGJYWoDWUyevlZ/8GSU4pJNipiheDu/cQkcr59V9ysihyVNcEktaddCkF2x6mL2Pg6hbpyQBq2F8Uz7YOOvWahypPH+aQKHNdxmlyeCjFHSLqn2J+wjcNYBHiFwfgLdMb4iBI4vQuD4YhuBI0Oo3i945xm1ppklgZEweUEtmczP7BtIuhG47+0tgfd3eeeHRYRaH+srcmUJmZvmvLWTPMch1Pd3FMMzK9V5TDgU6fjgfpBxjVGdwDkPLSOSRV+vL+D8Om2NTZQDafNcEo2Tlk8D59tXwPlN4+oVEq5lOrGeuY4GETiM5FlECHE5p24zZnuij+8Nad1Mw3N/E7gpxfEw5txaVZh1904/hIoRWiw6LOeYv/aRmRkQlDE0IjVMBI4dzhP0EeUNEZnTCgHhqTA6JN5AQHiasm8ie04XdMf4ihhC5YsYQuWLbQQOI3BN3ggcSWLooTacXFPGRHV4McZKHLoRuL9drII/n/PO8eIG1nh78SRIm+aSEidauzsmBoIT1AgLDhk6vnKGbBsicGVFPZZk0YOZtJndLWSui3iiLErNtSCtnkGWQaPXf3X+wz5wPnqQrNMqpbFf2mQOXEYmGeal9yEByvX7nDEbnwTOZ46BXOT7nDVJkU5Z99zfhlBR3qUZzeDAUh+69z+dxCCt7ABpxwLmfER+/BAE4DJb3SUKDRDDJImBlYnmaUshJCoDopNxiShve6g7g+yLTS1hzhGkwZiIVLjyD1/xEOJiRW6M0hn0eQjdMb4iBI4vIgLHF9sIHCVi0uRx7DF6UB7mtDJzsXjQPKsa5l4x/+LrTuD+cLoCfn60jGnnARkKjU6AQG2JoyAXOF45C4473iFVaWEbeTTMgRtb6dMQamtBAkwv7X7YjRQv7trG4sDRsbHgfO6YIkzqWqgazmtbwXn/dlXETfqppyHUvJIMSMxMZtp7A5b7cHztAkh9EDgafRKDP5CXGA1XFhfCj681wmjdPxq0wHUHCmC3a972VZx7gX0icNav01TgQpQvBXwMj8mBhWsPwNjWeVBBloBKg6Ubj0Be+QRonbECSuunMOd+kckvb4ZrX3rNw/GrjzMCh9DnIXTH+IoQOL7YJwJnD9G0q8Bh5IY5RgeuC0qWjuIwSZ3m99fGwr/fsFgLFSOFJpmImLX3f5er4e8XzZMfeIDRqNc2dJXVwKjc5U2emmyyK44IC24bInATx5LhVfpaVnxyfhx8dsl8jUwN57pZni/46EgX1GXFgZybw2STOh/aBc57B0BOTQe5IBfWjEuB8DCvAKPASR3NZKiV/hnIC7ur4NTaPkY0scwGFqTlULeNjsDJWZkgbZnLHDdYTFQk+4GVRfC3qzWKwHnvpy8CR7J/qYipZ19BnhrdNtnHg2EbgUPi0sogs2g85JVNgPSCsdDQpq42sGTDYVi+5RhpX7TuIKTk1DDnflFJyiqHq4+86mHuip2MvAmBEwLHExGB4ww9FNrDsB/OwXKeXms5f6o/HL0yA25/2TwCJ+GwIJanoNoxmeJ/ugROxuxAV++/THsLDp19aYl3uHFbawaMLVO/hJ2n1oDz2zdAris3RuBKCojs0tey4ol1xfDsjgrPc6yJRx/TUql+bmplRKxwnlsPjge2q7XlImIg/uIaGOnyXo8IXEsdiRLS5+JE/D+frYRfHCtn9g02jMCFukGuLWOOGyxmlSfBrQU58E9Hy2GMLrJJC5w0bxJIK6Yz5yOvbSmBx9aXkPcUvW+gGbYROEHfCM9ohGBXKhw6/w8wZ7m5vIWl1DHnIXTH+IoQOL7YR+BEBI4r9BDq3O5LWYTExEHTq/shPJa/KP3pdAX853nzSJrjm5c9kS5kblWy50vw18fL1aW0aBnlyIYGVdhwcv//Xa6CX+iGbHE+Gj4aInAzJ5DkA/o6VmB0Z0er93MxNYZN0lreYP3FpmfUc8cg6JWTZFvuaAbHJ7fAeVgtRIyQOXA1ZSCVe2vZ6cE++Oej/idw6bFuODVt8KNI7ggXFCVFw9K6FFjTWQy/vj5O6WdW4PCfifK0WBi1eyEEHV7KXAf5zckK+JUix2ZzPRPcUcr5vZd+XxkmETg2I1LQd4LdORCV3wbuog4DrtxJEESGptlzELpjfEUIHF/EHDi+2EfgXKSiP9NuAX5JdUwrhlEmc6v6y6+VL7b/OM9GhRBp7SyQVnUw7cgbmwrh7a2FTHu/UYRQOrMWpAm1kJXr/Ts+OS0TOrWK+RiRPLeebBsEDiNc0b0fQuXJA5sr4Sv7uhJTcM4iFhrWrV3b0xy4d7aXeFaa8JmQKHWI3Yf3lIa0qN0wB4zOQg0LjYQZpd4l3BIV4QnW5iYOEk+uzIc/X6yGYN3SbZrAfbCjGP54pgLe2lJE1s41K7WD5WfOWpXKGWDsE4GzDvAIgfMT6I7xFVFGhC9C4PhiF4GTI+NArmaL0lqBdcWC7+yAET5El3oLRtL+/Yx3GNGARRIDzoH72aEy+Hx/H4WjB7CiPtb0kqvU62PU71tbi+DqbO/fi3PxFPJoGELFQr5hvf+MenZlHtxZaD5pH38mEZUuIUhydz98nfD6cUj86gmmXYMIHF7LQsLvrSqECwvZ+Ya9AVeHcL53DeTS7od5zZAWtZFCudpzWuBocP1bLNtBtw8UOGx6uD0dfnuynCSRaO2awFWmx8Kr6wrgdEemIvnm0a63thTCvSW5pnKH8xrNlovjhRA4ATfojtEzKtAFkTHpEByRqLzRvR8yqTlV4E5UP+REBI4vQuD4YheB83XYcXR0POQ8uw9GR/H//fZOTIcbSy0iaRYCh6wamwJHpvf9/dtaEA8xkdbXR8bUq0OKKFOf7imBJ5apc+KktvHgePsKjHDFGgTOF1BCv3+oHD45bIw+4s+KdblIXbZc5YtdW0orJy0eol1RUJhpEeE7uxbks+vINs6Bc17fBnKiN6uUDKHm5ZAad/S5mOzwp7OV8KsTfRxCVd4fzscP9amQLZbf0Eulv2WhLqpJJiuR1GQapw9oAje5KAGuKGKPw+Gbmsy/424vyIEDk81FSprWCCNmtzDtvLCPwFm/TiFwfgLdMXpGKR+C6fm1ML5tEYREqtlMBZUtUFrbDik5lTA6yE0Eboxi6v5OUGwh0+aPhCSUMW3+SEhCKdPmj+D8HbrNL3FlsG3dEJBWANKXj0BASj6zr788vLQIXt9fw7QjIzcvAvnMRs/z5Q25pA4lbn+0qxTe21kKo6tqYXRpFdTcvw7GuHv/eyUlZUKIW72WKe5MGPXaGe9z/LlKG25Lt/eRtUhHtTSTfy4I2H5lG4yuqWWvZUGA8o9pQJrxs262ZjYAAEvcSURBVCIoKh1SktjfY3R5FWS0j4fW7dOZfcgjW2vgqX31ZHvEhgXk9clnNnmPUcRo/ETlPrVWM+eGKffhd6cq4IM95cy+3hKQlMe09YaADOPvH5KofiaFR6fDM6uKIDiqmz7iRGSMcr9dbHt3GP7WyfvO+nVen18E1+YXq++hrra4+AyYWZ0L8lblPb5/BXMOL4LjS5g2v6SbyKtIYvAT6I6hBS4oPB5G64ZJRwdFQYAibYFhXRNGRQSOKyKJgS/DNgIXEw9J3zgNo+N9j7D0xO9PV8C/WyQxYIFhx5sXPc/1c5/e2FBAomKkAn5CEoRUm0/O7w+Bl9R5bkhrURLk5agRLefOheD4/GGy6oJhDtz6WWpWrMm1+gsWycVIUHWG+Xss8NF9EHh3t3osDv9+90HDMDlG4MIKciCklB0mjVSu+5dzlfDrPkbgSB24F0+CnNn/SLmWxFCWGgOf7S+DopTu5+7xoFT5WWYJBohUVkgK8EZHGKOsnixUnDNZWkjm8jk3m5c7KUqOgdxE43cXDqficDB9LG+GSRIDKxOCwYfuGF8RAscXIXB8savAyenWH55kv3J8VF2JYbI5L3AodPdE858vndsIzjuqlNB8Z3cx/PhwOUjpGaTG1uVO/u+RvRPVzyxtCPW19ewcL8McuNgEn6rtv7mpEL7pQyIGZsOibNHtmDjh/MHDBHyeGecmWaUztKSLAFXgysbmQW4zO/cRMy7/+1IV/NcF82SSngjIzoINL22GUV1Dzv1Bn4U6rZH9fEpyu7knMeAcNCuBw2Hn88p7CzN0zebAeY4rzAepvYE5f6gRAifgBt0xviIEji9C4PhiG4HDArnjvVEv59XNpN4Wc5xGeAxIOxcashp5gUkMvzvvXdbLgMUcOJw/9qczFeRcFJrwsEg4PT3TdJJ4X9jclArFKTHw5Ao1WoXihEOMn+zxRvlGdpVeMUTgDq8gE/rp61nx7e1FZE1XfRsWEE6OjiKyjPX3Rq+Ypv4cBVx2axK14Lw0uxWcTx2B0e9egaDv3CBtBckx8OeLNbCw1vs5hAKXNKcJgtrY9VKjFIH7r/MocOaRUD04l+sTRWbTYr3vBbxffzhXBQuq+7aSgx69wPVlTh1vJhcmQHVmLLxKyTstcD0xFDXgkGEicOx8LMHgQ3eMrwiB44tIYuCLbQTOxyFUlDtcg3MgCvm6o9zgqmcn1hMsBA4prsmBKWsawZ2cABFRfD8XNjamQn5SDMzpKCbRnvBQF1yelQWzyrvWQg2PBveTB8i2QeCmNYKsK57bEysmZ8PmJcYMXBxWw2FSXBgdl9F6YqcqVTiZPlIR1Rx67VRc6L59PDg+vQ2O790mbdKEOnB89AA4N8z2HBcZGQs/OloB7+1mI3AIZtkebu/5yx5XeHhvezEp56G1oZwsr08hkkkf7ytaFirK+IK2PFhal0wydXnJOS8YgVPeE1K2+ecpDn3nJ/F9j/aWYZ/EMGkarr7Atgv4Q3eMr4gyInwRAscX2wic8nckZ/b8Za2BFf2Tzq/qU52vnsB1Ip37lzDtBKxXZ1H2IrUsC6bvbIPQ/GwYHZsAq8fx/ZuTcSj08ib489kKUubk070l8HhXFqocGgWOty6TbYPALWwDOcWHkQZcmskqyoSrY0THQ2uBKgpaBqwVjicPk3louI3y5/j2DTXDsWt/YGgMfLizGB6cnwMvrS2AaEWaSaZq1yocf1B+x1+etCjnMohoAofz0j7eVQI/OVQKn+8vJVm59LEDDco7Dq+ayaNe4DBCG6KId6ZFORAcnsXVLuh2BIVfjhy4eX72ETjrvxtLgZu7eD1ExuVA0+TZzL7Zy3dCdeNMcCcVQmvHCjhw7mHILmkAd2IBTJ23ARIyyrsWvE8l+/BxyYZDEJdWSsgtayJtx648Rh5PXH+CbLsS8qG6aabyc3OZnzncoTvGV0QEji9C4PhiG4ELcZMvee253FDVbf2y0FAXnO3IHJBJ11hfLviDa0w74nzpFDi+dp4MG0ZSX+CFyTEwuSQRytJiSDX751blGZY64kJiCvzHuQrCXy9UeoY7pZpScHznASJZfS0jYgVKw5Rib+HafXsnwKhgF3y0qxgKkmI8UUCa6AgXpMZ4Px+fXplPhka151oh35KUGPjhgVJYeWc5OJ8/CVJFMaTFuMnviBJHX3egoVcB0QQO55s9vjwPkpXXNrHQez8mF8VDQhS/+23FmKAIyE1wk74IUARMLi8y7NcEDoe8p5eqw9pWw6TPrcqH19cXmu533tkDzi+xy8XxYlgLXEF5I2QXjYWjp68x+2Yv2+HZRoHbc+ohSEgvg8rxHZBT2kjay8hC96mw/+wdzznnHnoO4pXjXAl5pO3o5UfJY9OUJZ7tWUu3QcfCzczPHO7QHeMrQuD4IgSOL7YROF+HUKMTwPHYQRgxAJGC35wshz+dMZ/87ry7H0KfPww/P1YGb202foH+YH8pSSzQnidHuxXRjIT14/n87cmKNDmfOES2cQWKX5+vgaub1OFM5/n14PjwJllUvj8C11IQDyvq2derF+WNW9Uo2phAVWpiXFEgre8EqcE4b3BFfTLsm+T9sk6nluWKcsWSSNZn+0uIdOj3pce51Ujj2b4LnFzZtyxgrEsn655rAhcYFgVfvzwB9MtXITi8HB3Zt/vtCzgcTOYiKo+Oi5vA8ZUzhikE+ghcknJc8LVNEHtqOXMdcuzGWRC0cirTjsjJKTAqe+A+34aJwLET6jVSsiuZNsHAQHeMrwiB44t9khgG7gOOJ7YVuPTuh1NHKeI24e5aCAjj/8X5t4tV8L+XzZMYpAljIX7PPPh8Xym8vaUIpJktZNgRv1wxgeHnuBaq7nhsz4izjiT6Ai7h9MLurkn9gS7lC/w0OB7cSZ7LTTXgeOeqInDZ/RK4E9My4cz07t/bX93gnTw/rzIJLq8shTcfaoe/X6mxjoiaRHpGBsfArZ210LqCzZQMC3Up/VDZ5whcalsN/OJ6A8R0eods+4qWxBAbHwcf3ZwImQXG7w0e8+x8RVbEDRer17d51kJVyEuMBsf7N8CJxZ1NEn3qFoyDmcvHMu3kfOVvMXQAh4eHSRIDKxOCwYfuGF8RAscX+wicPSKFdhU46YD5ItwaOHz52t5KiHKxX0795R8Pl1lmPzreuEAWs187PgWy4qPhwpwcMp8I5ySh+P3xTCVzDi/wi/lQV/V83L65pABm1aqjCLI7Hhwf3VT39UPgDrdnws253f8NFo4vhBHBLlKmgrQpv/tbu8rhvy9XgdtkJQk5O4sM921tTjOUHCFZqLMaILCNFYmYyCj4n0tV8PeLfbufm5Sf9ftrY2F2Tf8/9/RZqDkpsSTiaFX7bijRL2aP2cE4BUGO8L/vp2EicOxwnmDwoTvGV4TA8UUMofLFtgJXZhyepMEht72T0g11sHiBE8Cz4i3EMCvLUIw2PFR93ShUvz1VDj87ZJ5R2V8OtKWrwjhT/fvA1/ir4+Xw3d3qkC3WXYt9bDfZ7o/A/cvRMvjX47rhY5M5fHu6hkXlGO88MFwLtKdIY2tBgmHOFclCPVgKH+xkhzpTY3EOXKVyT/sWgcP3B2bJms3x6glp+3xSLkV7ri2lhZmbH+8qJrX33tlaZJkEMFToh1CxjA2931+wzxCq9es0jcBF5bcLBhD6fosInP9hnwicEDiu0EOoPaF8wcqY0aj7ouVJuEVk76NdJaS8Bd2OovAf5yvJKg5a29hs3+py7Z6YBhXp5v01MjpO6UsXXHx0EXkeoIgVCs53dqnyg2uNSqfWqsfqs1CnNhpEqye2TEiDPW3eCIk0aRxzzPXlRZ4hUZQYffmO7iCT7/WFZ4NjSFSu3uQ+laXGwq9PVsAv+7gSw7yqJCJ/E/Is1mntDqo0jRaBw6ggznPELFBct1bbX5+lRuWY6wwgsysSlb4vMQiqJnAo95Oquv9u296SBtNLzZNPnEdXgLRjAdPOi2EicGw0SDD40B3jK6KMCF9EBI4vthE4dwLITebzzsyQ3XHgPLQMRkTwT2KIPbAACl80z8L70cEy+MgkYoRkxrsVAfO+nhfX5BPRai/qnUBZzqXCpZGOrCBV9eMe20Pa8Lo4yf+97apMOo+tJPOd5HFVxgicSQStO/54pgL+eK77YcunVuR5xAHn3OlLg+hxvHxKQS0jghydkkGiWNpzLQvVDLwX/3ykFG7O69vnQZMibhihxOWv6H2+oiUxIBhpxP7HZBXtd6nJiCVyR5/XH2KjokxLhWisHpdKSprokz88AhcZDQ1rW5lz9Hx3dzF8dUOh+c/w9Z8pH7GPwFlLsBA4P4HuGF8RAscXIXB8sY3A4ZeG7otD7mEINSA0CpoOzoTRIfwjcAmLWmHyM9uYdsIYF5GXK7OyoDGXje7ovxAfXZJLMjWnlvRO4KyG+1BmcAWA8IgoeP9yk6cdhWhBdRLZJmt/vnKa1KjrzxDqz8kQapnnOZauwNcV7fLe51e3lBCRwW0s/SJPqGOug+CcPFLapOt5UbKxfhkKHCY9mC1DlRLtJitb/O5UzxE4HO4+2J7OCjCnIs96gUMOtqXDW5u8JThClNfP/Ox+Uqzcq+6mB5AVIc6oEVcN/RCq9nro7F6NjtJE6LQo/4KZw0tq1ffVQCAETsANumN8RQgcX4TA8cVWAqd7Lqd2/yE/MigSahaMVR75C1xqjBtqc1g5Q0YFuqAlPx7+cLoC/oXKOH1hdT68s80rns0+Dt9taEyBSl0ED9kzMRX2TFK/SFDOcs8uI9soPThk+6MD3jl3uP4qPvZH4DC6hJEd7TlKKoqKvs7ZjquzIVARaKlzgtqm9IHz8UNk+TP9tRwPbAfnvX3qcKtJJHBkdDJERkYRMaX3Ib9X5O1XOpm04mJnFnx7ezHE6V6jNHkcOL5xCZzzjDXd+oJe4PR17DRQ0Hs7jNxbUGy7k0JpwWRwPnfCcF81gUPxaytS+w0zl+lzEZwzKScalxlDucbixHhOd/LYX4aJwLHzsQSDD90xviLmwPFFCBxfbCNwQVEgx3n/6/dkOFqAS2k5T681LZHQX3Bo8m8Wi6g/sSKfiNqxKRlQkWa8t+vGp8CXFntXJ7CKqFmxqCYJsi0q5+NQIM5t0p5jfbm/X6yCnx5UBU6OjIXEW1vIdn8E7lJnJlyb7f0bbM5j56cldKjz4lo61OiYnJAEzveuKxiLH0uTxgIuqSVnZYJcWmjYh7XWHPcOktUXAgq99wyHobXt2eMyYEJ1z1/2KB5RVNkLHGJ3PHqARCbp431FS2LAWm/v7yiBFEXw9ZFElJ3uZKs/mA5xdkEvkaYJ3CvrCuBfT5TDvJVjYcpydg4jEpifDYHlxj7BbOoSDkPOPWEfgbN+nZYCF5NSCq74fMgta4Hx7Us97bFpZcyx/kDdxAXksagGCwinQag7E6qacBWJNEgvHG84NiwmGwqqJkNO2QQIVjpRa88pb2GuO1jQHeMrQuD4Yp8kBnuIpm0ELj4ZpCVTPM/lZvNhOc/+tHRwfPwAjEji/77+sSJF/3bSfOiufNNUOHdhCvyPIk+YAVqVEev58p5amgSPrfXOj7t9sgUi3dEgV5jPmaOZWBhvGcnBtVATohVp3aUmMWDyAJYteX+Hem38op88Sy19YkhiqCoFOcyHz6gxkaRgsPYco40YlSlKjiGJEnJqGnxFEQRXhAsOTPH+EyM314JcbJTukTEJMDrKK4CTChM8Eirn50LIpY3w00Nl8O529XfA4eazM7I84ls/uRRyG3q+dxOU1/j4srwBywrVkhhwaao3NhaSRJPjU72/Oy4uj0O+9Hk8KErpvVBpAofZyji8HvjmeQj86ll1CTTqWJz/9vLaAtN/MrZNSCMrjdDtvBgmZURYmUjOqVUEroQIXF7FREjMqvLsS8yqZo73B9rn4eoNaVBYo2Z5osBNXbgNEjOrICQqA7JLJ3iORYFLya2D2tb5hmvklAmBG2iEwPFFROA4Qw+hlhaqa3/Sx2mkpELGzfUwMpL/74eFTFNLzQXd8f1bMOXrB+F/L1XDn89UkuWztH0oc7iup/b84e1VypdqFEiT2TpnfQGLtwa+dZFsowj98ng5vL9HjcA9sTwP/qa8Jhy21QucXFzgWVu0N5StmAAlW6cZ2p5Uro2JCyTj1xVLhiyxvaK5+3mK8W+chJQ3T6lra8YlQpAugogER8TBZ/tK4d4SbwROG7rDYTzMssV5cPR1aZ5cng+f7VWzQ+l9PNDXgUMmFsTD5a57gOAQKq66QZ/Hg+4icLTs6+fARUe6ICE9GRJzzKcJ1WbGMRFkjcPt6bCwxji8ypNhK3CCwYfuGF8RAscX+wic+Re8v2EbgYuMA7neO2wp7V5EhkmZ4zSUL7bp86o8k+l5smZcClniiW5H5HHVkLypA35xtAze22aMDmHpi8PtGSAnJENYUhL885FysqQRrglKX6ev0MtVaeCX8W9PlpO1V/UC59y/FOSs3r9Xf3WsDH6nq722rM77uYFDodLEsTChtRACQ1ykJl32wmZovbSYuQ45HrOKq7ruo4mIYBIDKfJrMt8RMzz/70o1KeZL76N5ZmU+fLKnhMxdpPfxQC9wcno6qQWHcw8tV53gwLSSREPGLuJW3kdFSer3zRubCuG/lXuDUUFtvyZwJOI6rhIeUP6ZuDqr930/WAwTgWMn1AsGH7pjfEUIHF/EHDi+2Ebg6AhcWvcf8jhh3/nscSJL9L7+gtEfq/ph0t294HzsAFmJgZ6vhsNO98/LgdzEaLIYu3at3a1pXOZIYRKD+5Fd8I3NhUQgMDM0KZ4dYjPMgQv3TWr+cLoc/qirZWfGuf1qJiyWR8GK/72N1uCi9SiY2nNSRiRauc+6YVaNpGg3/Pu5CvhdL1a2KE2NgbMzMg3RqsKUWPiXS/VQb5Ip7Cv6JAY5Wn2twTpxClO2rbI9BwpcZ/avyv3R/86awOHyao6XTzPn+Av2mQNnHeAxFbiQuEIIz2iAyOwJfktYEq7TanzdYcmVEJHdzBzrL4Ql10KQCyNu7D2nO8ZXRBYqX4TA8cWuAtcTWN7iwIa6AZn3VJIaC3nZ5iUWnLd2g/ORfUw7Eud2w44Z+VCbGQtpsW7Y3JTa7RCYr8jKPcp68SBJskBy0+NBTtF9hnXNXetPEsMD87JJREt7rh8i1hjflE8iag05rHjpaS5Jgln13i9BjGzqsyJR4OqLUyA9g000wAn1f1F+x94MoZoxblIx/PPlsTB5lrkASgvamDYr9AKH5T3o/QVJ0RAxyCsfvLw2H/6sCJz+/e8ZQsUi10V5zDn+wrAVuNFKB9iBUJ3EhSryRu/3T+KZ+y0Ezv8QAscXuwicHBUPzg5vjbOeGBUYCYsn55KCtvS+/oLFbP/dopitdHMHOO83rxE3vSwBbi9Qh9twzc/fny6HzB6Wl+otOLE8LTEWKl4+QK6drghieJQiDqlddeByshW53EnKSvRV4DBK+K8nsXRHOVRlxJBSJZlx0WTobrqull2AK4YI95KTM0hUEJMb6GshubtnQcW5JUy7hisyFv5R+Vk/OswmjJQqEv0fiqBgqRR6X6/BWml0Wxdyfu8FRxM4XN7r306Uk4QOvCfa/sJkFDh+w+SErvd1lsX7Z8raJviXi3WmZUQ08hOjSWIMfS7SUZoAcytZcR4MhMANOV4ZcuW3m+z3T+j7zUfg2P/I/BEhcHwRAseZ6ASQ5k9m2y0YFZ8IoW9fUB75fwn9RRGHv1qJQ5giK3FJZBmieF3dMSRReb642juceG12NsmsZK7RB8Zlx5E5V4d3jCfPUVxRtN7tqjuHIhVwcQPZ7qvAIX84Uwl/PFdFImVWw751BzuJwAWlpZIhbLmOFTAk44WDkPWmdyUGuoZaWHgsKRz8k0NlzEoGmMzws8Nl8IiuLIsV6xtS4WsbC0lpFX17JFVapK9oAofLc/3tQhX80+FSsmasfv4Zb0Y215DkD22tXZrbS/PhJ5fHQaBJBA6jvqVp0bB/cjqc6TD/nMI5nj8+UEoinfp2s6xU3gwTgWMn1KMYdUdV/WSmbajQXnNU4TRP29SZS+DDT3/MHDtp6gJ49uWve/a99vVvM8f4yriWDli2ZjvT3h30/RZJDP6HSGLgi10ELiI8imT30e1WuFxuOHFvCURxXsIIwbVOf6grkKtHntIIiSeWwef7SuHtLcYsTCzfgBmVONSJz6ss1jXtK5iVG36/WiwXkzd+d7LCU4Jj174W+O+rNZBZkd0vgbu7swaeP9HAtOuRVkwnGbHFZ6yja8jjl9vgxZvtnufTS71lRBBcCxUL8GIpFKxph4vP68+/f262pYDoubMwhyQx4Lw5rQ2zcX+j3J/ZFf0XfC2J4fKsbPjfy1WkiDMmVwykwJWkxSpyxrZr1GTGkRIs+jZN4LZOSIOvby4k/4TgPTBLtsBkG1x7V9+GtfSsVmfgyTBJYmBlQi8bG7YegKKKRvjej34O0Yl5sHbTXjh47ALZvvXIUxAcmcwIykASEJpAfrb23EzgOuetgn/85e8N561Xfg98DAxPgjOXHiTbL73+LcMxr775HrzytXfhrfc+ge9876ewY+8J+NrbH5F9+4+eh4PHL8G5Kw/Bi6+9DY8/+yqcv3qb7HvmpTcN16GZOW8lBCiPyZll5Dl9v4XA+R9C4PhiF4HDiM4Y3bJYUlfh1yNTMkwniOPcn+tzsk2XYeKBXGg+xCZd2QLOB3fCvcW5zGL1lzqz4FvbikGqr4TY8jx4dX0BZMSaD4H1BRTD8EvrPc9xGE8rX/H1wzXw/12phkm1Gf0SuM8OlsM/HbeIPnYxNlut8r95pXlGrB6rKB4SFB5LkjEwGvRfFyqhTJEWbU4XyhhKEoodfR4Nlm5BgdOvFpGfHAP/dnUs1FJ91Bc0gcNab788Vg6/OFYG/32hCkJD+UT4zJAxAhdl/Q/N1SWF8M/XGyBAL8RdAofR2NHt44i46YVZz4LqZCJxdPtg8IUQuCeffx2efflN+OCTH0N901RVSOauhKCIZJgyczE0T57NCMtAUj2uDeJSCj3PzQRu4/ZDkJFXZThv5fpd5PGzn/wSWqfMBVdcNhG24MgUzzGnLtwkUvrI4y/A3ceeJwJ3596zZF/jxE64/tA9KCxvgHc/+gy27DoCM+auIPu+9cFnzOukWbRis2ebvt9C4PwPIXB8sY3AhUaDXFKge66Kyc7WNNNhnQR3FLxzpIZUx6f39Rfp6EpwfOsK0072TW+GsPNrSATuzkLj8F51ZizsafdGjIp9KMLaG+QQNzje9a52EBscBfEh6n3CaNV/Xq4h87P6I3DPH6iDrx2vZ9oRLE8hJ3mnnSyoSibLV2E2Kn0sUvTaISj+pncI1XCtmASQN8yDZ1bkkaKz2PbU8jxyX7UM4N+droCPd3uX9bICf+cH5hlrtUktdcq9ug7StEbmeLJ/7xLT0iZmaAKX6HbDR7tKSNbtN7cYVzEYDMIUYcRMXtz+QLkvf79aY4xodgkc0lNyD14L51LS7YPBMBE4dj4WPWfLn9Fec1TBFGYfzeyFa5i2/jJrwWqIiMlg2ruDvt9iDpz/IebA8cU2AudjFuooVyxMur4MAtx9i7Dg3DSsoE+3I85rW8DxtrnAOd+4AKFvX4RP95SQArdaO0aafn4MJ+SXkfVZk2OjyYT3sVl9e31myIpwOM95I3A4B68szSuJ2pd2fwTuS0ty4cW1OpHWIWN2o+5+Y/SPrLcZHgWOO7vBsX+p4fiiu5uh9OndnucFSTGGNTZHBseQa6CM4/Mk5fHLy/I8tf1OT8+EXa19/ydb6mY5NmnDbKbNA/Ve1ObA4evCFQxwjVZMsNDm9O1sSYMMi2QDnmDED0vU4PauiWlkiFT/z40mcPg6sVAvfb6e51bmw5sbC03/ORpo7DMHzvp12lvgQnVJDHk4L8/kGD+Evt98BG7g/3B5IASOL0LgOGMicPhFhDXUTDNNcTixY7zpIum9xWr4FRdldz57jGlH5KoykDbOJpEP/ZcfThzHshe4BmVNbTakFaaTKA2WO6Gv0VdQoBz3DnieYyZuYIT3H8jYVnW4sT8C98q6fDIHUN+GQ5PTdFmoS7rmqs2qSCKJAvl5KeB48SQ4nj9hvN7zyj3EpZyUbVz6bMSHN2CELtMYy4hIC9tALlJFC6OIH+8qIXXd8DkOEVsNAfaEVF8Bjg9ugtRcy+wj+zfPZdo8+5T+1eYxIprA4X34pyNlJGEC6+VpoomZorySVXoiqGteXNnKFnjrxkR1dYyufZ4InPK+kArMpwBovKW8Nx9emMO1zE1vsY/AWf/zYGuBi8ho8Lzm4OhcZr8/EpZSw9xvIXD+hxA4vthZ4FCQltUlM1GC8rQYkBNTIOaNkzBiALJQHc8cA8e3rjLtiHRxM8Q9uIVE197b7hUdEoHDjMquxeWRM9P5vUdOTMuEsoxYuHh3nqEd5zvho+Ppo+D45CGQ2sZZChyuaUq30WBx4sU1SVCRHkMielOKvfOwMOKEpSm+t7eEiMTx9dUQHh4FxfnJqkhTfXhqx1i4cVgVNlwazfldRaiWete7HRGdBI5vXAbHa+fIc4xoYn27cV315TC54e4i49Bob0nLTIIfX22AoqL+f8ZrAofDl/95vpJEbvVLZ2UnuE0TBXiD77HIrnpzL60vhL8oryVQt26tJnAY5eysSISI+DiIrjYf6sWEkSnF1gkLAymkw1bgkKj8dogpn+eflM2BkLgi5jVjG+5jjvcTwlPrmdc8EAKXkRAGISHhzDHaPm377toA8riuJYg5Ts+eaYFMW18RAscXIXCcMRE4M1Aw/nquEh5ZkgudHaUkCkUf01+Cb26FhDdPMe2I4+E9EHVrK/zuJAqccSmtyPxMKF3ZSrZjIl3wyroCyOO0Pmfp3lmQnJ0CP9YlGGAEUSuM61w/CxzffYiU9dALnDyuCmS3KmG4CDstwzRYkLYy3Tssi9mO2jYKBMqBlr344PJCGNVUBWEbZzLXQS7MzIRHFqsCNnd6MfzmUi1cXOwVChKBWzGd1P/78vJceGFVPqnBNyG/S0SeOAABuqQNX5hclQq/uVADi8b2/3NPE7jytFgicDjXUb8/V+ljnFNGnzeQPLkijwyhmi2lpZHz4gHIe3ovcy6C0UN3BCv5CL6vYl0D9/sME4FjJ9QLBh+6Y3xFmwO3sjkYitPDYO/0IHhg+RiYWR0MW9uC4OCMQIh1h8GOKUEwvSoEri0JhNKMMIiODIdH1o3xXOf0vEB4fOMYmFIRQp4HKyL4/LYAeGPPaChOC2V+rq/YR+DsksQgBI4rvRQ4rHqPC8k/vaoA5LZxhiEkX0ARsVr8vHFyMey53Mm0I46PHwDHhzfJ2qNYdqGtKMGTaRmQmwWZqyfDGOULELMDVyrygPushmppLNd1VSR1zMUNJLPwifunetoxIqRlwjq3zAXHZ7dBzssxCFxYmMszJNkbcI4XXR5FAyNweUkxsKNF/dzM3zsb5KQUMlxJH0uTGB8Lf7paBy0V6j/NclwSSLuXwubmNFKvDLNNn1Kk5F+Pl6uL3ivvB/dXT0LEC0eYa/UGLOnyvUvjoSnfOpOzt+jXQp04sZBEJls4XLc/TCxKhP+4XGPI8qUFDuf5SSs6mHM19PMRB5NhksTAyoRg8KE7xlc0getQ5CwrKUyRuFCYVBpC/rAuLxoD+zsCoSIzFLITQ6FIEbE5dcFwUxG8MqXt7Hw1wobHPr05AFY1B8HEUlXgxgSFw8GZgfCltQGQHu+N3vUVIXB8EVmonOmlwOUlRpPq/FhvbfvCUkMZBV9AWUqONo9AOO7uBcdzx5l2ROpoBmn7fM9zfYQqJSYKDralQ9bkSkgpy4EX1xQQydvVav1FoAdFhi5NohEbhfOsIqF5Qj44Xj8HjrcuQYzbDWlx6ueP8/pWcH6uCFxjtUHgpNUzICCpd2uVIrh0FUbBMEORnh+F0bvAIKwzpkpY1JSxEB4WCZkWIozlVpx3vEkMn+wuJpmc2nNXZgbpS/x5WErkpwdLSZ21znJ1WPy9/RVwe1H3c7mswNe+oj7FtASNr2gCh3392b5S2NiYSjKQeVy7J/QRtjFjcL6deq+/ebgG/u9KNYToIn+0wPkrQuAE3KA7xldQ4PJSwsAVEU6iZriNH3RxbnUbj8lMCCPb+KGCj1o7vR3vVodfcTsnWR2Oxe2oyHBIjfMei8+1bRyatbpernINLAaJ28nJ6oc4buPrDAlVr4GvKTXOez2za2jbmYne7RhXOJFM3A4Iwv/O1e3wcO9rxfugvx6er792cqzxZ+KXanFeKrl3STHeY7XXitv6+6C/Nr2N52vb4WHhZM4ObuN/nQnR3utldb0ms77BPvBeL5y8PtzGexoRl0m2o5X7kBTrff36a6B4669Hb2v3J1H3WgMCw8n91I7Fe0SfZ7atST5ux0R5rxEUFgNu3fslres14WvFvtXas5Osr4f3AV8XbuO9097bOEE/TNc3Pb1W/EcFH1PivO34HsfXkp8aTu5HvK5vrK5x/4JkKMqIhDHLpkCe8oj3T7v3+F7B/sZt/L0TY9RtFA/8PbTrGfom2fjezrm7mogHbuP90u5fUIjyN//dm5D9nhoVwnuxqkGNbuH+6eVRZP3T8rGpUFybTCa7F6UZ7yX+7WrvtcDgcEPfHJmWCB0VUeQ+6PsGHycVu8hw6Z8uFkHad06B8/u34OD8DNjTlub5G0+MQ9ELh/y0SAhWvtjxPuTmRRM51vcNfW399o+PF8L7R6uhJgeLK6ufRzXZETCzLJG818l9CI4kj52VqiTS18C/KdzOV+5T4kfq/DZsP9SeBknR6rZL+b0L093w61P58PHuIvL+a1V+R1yLNS85HDqr3PA/l6vhf64WG66Nr13ra+ybyK7PnbAw7+cvHqv//KXf22avFbexb7Rt/Bn4mY7bKHD4cwtSw2BxTTJzjZwk77b+vY3na5/h+Hqwb3Ab2/SfhXiOto3X0l+7IV8VONzGn4+JHbi9rSUZ/ny+AvK7jsX3UUGGKsfaZ5rZ76t/rXFu7zZ+PuI9xG18f2rfK/TnBD5afSfgfdY+d/B30u4fvo+0+4DXTklN8Vyvu9eq38bPNG0bH0N1nzs9fQdq2/rvBHxN2vsF+yYhWj0P74PWN90N9QqB8xPojvEVUUaEL/aJwIkhVK70MgI31MiZWSCNMy90q80Ro9t7C5YFwSgb3a4HhwZHRMSQeW0oemZz2qySGHoDzikcabK2aXcFea2QYxMN65HGuaIM18E5cBhRNatHhpKIq2FgpJXeN9joh1D9GftE4KzFyJ/oIQLHTqgX9B3Hy6fg/93eBPfdXGfg/z28GRwvnWCO16A7xldEFipfRBIDX4TAcWYMKxv+Rn8EbjBBgaPbDPtN2oYCLYnB3xECx5cekhhYmRD0jfteOQ73XV7B8p2bJLX+/71wCO57+yJzHkJ3jK8IgeOLEDi+CIHjjBA4bvQkcP6CEDi+DHuByy1tgsTMCiiobIGs4vEwbf5GyCgcS9rS8+sgIaOcHIPHpuXVkse4tFLP+et2nWWuOZxhxA354DqRN4377l/LnIfQHeMrQuD4IgSOL0LgOCMEjhtC4PgiBI4vPQgcOx8LWbHlOHQu3QZrd56B6KRCSM2thSlz1kPjlEUwf/UeWKvI2ezlOzzHp+XVkcf4tDJP26ptJ5jrDmfuu7aK5VuXwPHZHQ84nEqfh9Ad4ytiDhxfhMDxRQgcZ4TAccM+AifmwPHEPgJn/TpNBa6hbSGU1k2B2uZZUFA1EcKis6C+ZS7klU+AFEXk8LGkth2qG2d6zolKKPCcG+rOIo/0dYc79710BO67sdrIzTXg+FyRtx/ehfu+eQHue+MUcx5Cd4yvCIHji32SGOwhmkLgOCMEjhu2ETiRxMAVUUZEwDBqbjvc9+4VcHx0v4H73rkEo1sbmeM16I7pDYGhuurkQuC4IgSOL0LgOCMEjhtC4PgiBI4vQuBsAN0xeqLis6Gkrg2KayZ72hLSS2DS7PWQlFlGnhOBww91P4eM55u0+xtkuMKk3d8Yg/NiTNr9jZGh8UybP0KEw6Td3xgZ6Gba/I2RQdEEut3fIMJh0u5vBEbnMm3+yKjQBKbNHyH//Jq0+xsB3Yhmt0kMgsGD7hg9QeHxUNsyB6ITcyEwVI1k5JY2Qs2EOZCeXwOjg6JEBI4zYg4cX0QEjjP44U63+RkiAscXkcTAF/vMgbMO8AiB8xPojvEVkYXKFyFwfBECxxkhcNwQAscXIXB8EQI3SIQlVUBgRApMnLEMyuraYbTyRtYTEJYEofHFzHkI3TG+IgSOL0Lg+CIEjjNC4LghBI4vQuD44rPArd99Dhas2QdzV+6GWct2kJpv2r7Y1BLPMTEp5jKCuBLyoaZ5FlQ3zSRzt+j9w5HAiGS49PDLHsKjM0wljj4PoTvGV8QQKl+EwPFFCBxnhMBxQwgcX4TA8aUHgWMn1Gss2XAYKhs6oKByoqdt3qo9MH/1XrKNktfasQKWbzmuiFon2bfl4BVwxedDWHQ2OaZtNhauTYNUUuiX/RnDCSx4fO1Lr3k4ffMZRdriGejzELpjfEUIHF9EFipfhMBxRggcN2wjcCILlSvDNgs1Pr0MVm07CYs3HCLPsWjv1PkbyTZKWvnYaeSYFVuPw5qdp2Hn8Qdgw94LEJtaCsnZVUTsjly6B5M6V8HMxVshKiGfFAKmf85wAyNwVx951UNEbDYjb6NDE5jzELpjfEUIHF/sI3AiAscVIXDcEALHFyFwfBm2AtcdKGn651UNM5hjaLDoL902HAlLUYeaFyoC2zB5ASNvAWHJEJpQzpyH0B3jK0Lg+GIfgRMROK4IgeOGEDi+CIHjyzAROHY+lqAfKF+oEWn1EJnZYCA8TZE75Q3DHN8F3TG+IgSOL2IOHF+EwHFGCBw3bCNwYg4cV+wzB876dQqB8xPojvEVkYXKFyFwfBECxxkhcNwQAscXIXB86SGJgZUJweBDd4yvCIHjixA4vgiB44wQOG4IgeOLEDi+CIEbRIKjc8Fd3AEx5fMMuIs6IFiRAvp4DbpjfEUIHF+EwPFFCBxnhMBxQwgcX4TA8aUHgWMn1Av6RkRmI8SmFMHRS/dg2cYjTBIDEp42jjkPoTvGV8QcOL7YJ4lBCBxXhMBxQwgcX0QSA1+GSRIDKxPIloNXDc9DozF6xB4n8BIWnWmoA5dTMp4ROIQ+D6E7xleEwPHFPgJnj0ihEDjOCIHjhhA4vgiB44vPAhcSlQHx6eUwd8VuKK2bQtoiYnNh5bYTZLt56hJS1233yYfgzAPPMOd/UcEF5vUCd/TSo4y8CYETAscTIXCcEQLHDSFwfBECx5dhK3AXbr0Aoe5M2HzgMinYi22b9l+C+LQy0paQUQHbjlwnBX3nrdzNnP9FJVC50VcfecVDYHgSI2/4pqHPQ+iO8RUhcHyxj8CJIVSuCIHjhhA4vgiB44t95sBZv06RxMCRkJg8GBORCpFx2RDmTgd6HdRAVxYEK1+49HkI3TG+IpIY+CKSGPgiBI4zQuC4YRuBE0kMXLGPwFkHeITA+Ql0x/iKiMDxRQgcX4TAcUYIHDeEwPFFCBxfhMDZALpjfEVE4PgiBI4vQuA4IwSOG0Lg+CIEji89CBw7H0sw+NAd4ysiAscXIXB8EQLHGSFw3LCPwIk5cDyxj8BZv04hcH4C3TG+IgSOL/ZJYrCHaAqB44wQOG7YRuBEEgNXhm0WqmDwoTvGV4TA8UUIHF+EwHFGCBw3hMDxRQgcX4TA2QC6Y3xFCBxfhMDxRQgcZ4TAcUMIHF+EwPGlB4FjJ9QLBh+6Y3xFCBxfxBw4vgiB44wQOG7YRuBEEgNX7DMHzjrA063AleZmM22CgYHuGF8RAscXIXB8EQLHGSFw3BACxxchcHzpcwTuj7cbmDZk9rId0DxtCdnWHktq22Dm4i1Q3TQTTt3/FGnrXLIN1u0+R7YPnH0YCipbIb2gnpwTGZ8L0xdsgohYIYkI3TG+IsqI8EUIHF+EwHFGCBw3hMDxRQgcX/oUgVtVVwj/dawJvr1xArNv9vKdUFwzmWxrj0cvPwp7T98i28euPEYeZy3dDuv3nCfbp248qchaDhE47ZyTN56AsJgs5vpfROiO8RURgeOLEDi+CIHjjBA4bgiB44sQOL70IHDshHqNvy5phlDll6Tb567c49k+ef1JCIvOhvmr90FD20K1TZE1fDx88UuwdOMRsr3t8HU4c/MZyCgcR87JKhpPHoNNrv9FhO4YXxECxxeRxMAXIXCcEQLHDdsInEhi4MowSWJgZUIw+NAd4ytC4PhiH4ETETiuCIHjhhA4vgiB44sQOAE36I7xFSFwfLGPwIkIHFeEwHFDCBxfhMDxZZgIHDsfSzD40B3jK0Lg+CLmwPFFCBxnhMBxwzYCJ+bAccU+c+CsX6eIwPkJdMf4ihA4vgiB44sQOM4IgeOGbQROROC4MkwEjo0GCQYfumN8RZQR4YsQOL4IgeOMEDhu2EbgRASOK/YROOsAjxA4P4HuGF8RAscXIXB8EQLHGSFw3BACxxchcHzpQeDY4TzB4EN3jK+IIVS+2CeJQQgcV4TAcUMIHF/EECpfhkkSAysTgn7gyoSwpAoIT6kxgG1B3dS8ozvGV4TA8UVE4PgiBI4zQuC4YRuBcwuB44l9InDWr1MIHEfCkqsgMCIV2mevhopx02B0SLyBgLBkCI0vYc5D6I7xFSFwfLFPBM4eoikEjjNC4LhhG4ETETiuDOsIXEldO9S1zGHaU3NrPdtJWVXM/i8ygREpcPWRVzxExGSaShx9HkJ3jK8IgeOLfQROROC4IgSOG0Lg+CIEji/DJALHTqgPdWfA5gOXYfGGQ7B+T9di9OfuksfskkaYuXgrtM9ZCxkF9WQN1KSsSvJIX+eLRn55E1y886KH41e/rEhbHAN9HkJ3jK+IJAa+iCFUvgiB44wQOG7YRuBEEgNX7CNw1gEeU4E7dOERSMurhZiUYmibvYasV5qSWwOJiqjlKAKXmFmhyNtYInDYTvZ1tdHX+iIRGJEMlx5+yUNETBYjb6NDE5jzELpjfEVE4PgiBI4vQuA4IwSOG0Lg+CIEji8+C5yvoMDRbV9EwpKrISgiBeYu3wFjW+cw8hYQlgShCaXMeQjdMXpGBbog3K1cPyoFRuq+YPLKmyEhvZhsiwgcX4TA8UUIHGeEwHFDCBxfhMDxpQeBY+djCfqB8sUfnj4WIjMbDYSn1UOQK4M9vgu6Y2iKaydDdXMnhLqSyfPc0kYorJ4E9RPnKR+SLhKBG+PK9HuC44qZNn8kJLGCafNHQhLLmTZ/JDAmj2nzS5S/X6bND8F/MOg2fwOFA+eS0u3+RmB0LtPmj4Qk2eMzKcgmf+shCWVMm1/STfYxlwicoP/QHaMHo26jg91E1PRtGJkbHaRG3sQQKl9EBI4vIgLHGRGB44aIwPFFROD40kMSAxsNEgw+dMf4ihA4vtgnC9UeoikEjjNC4LhhG4ETWahcGdZlRAR9Izg6D9zFMyG2YoEBbAtW/oOij9egO8ZXhMDxRQgcX4TAcUYIHDeEwPFFCBxfehA4djhP0DciMsZDXGoxHD7/D7Bs42EmiQGJSDPP1KU7xleEwPFFDKHyRQgcZ4TAccM2AieGULlinyFU6wCPqcCt3HqCPC5adwBiU0ugqHoSZBaNg7yKFpjcuRpmL9sBaXl15JhV205CfHoZRMTmMNfRWLbpKNM2HEnJqYLLd1/2sGT9QUbgEPo8hO4YXxECxxchcHwRAscZIXDcEALHFyFwfOlTBC67pAFcCXlke97KPaSwb17FBOhYuJm0zV25mzyu3HqcPNa3zoHZy3fAmp1nPOes2HIMqhtnwvrd52D3iQdhzvJdzM8ZTuSUjDcU8j147mFG3gZO4EQZEZ4IgeOLEDjOCIHjhhA4vgiB44vPEThk/Z7zpIjvWkXIEjMrSRsKXHHNZJi+YBOs2naCtB2/9jiRtpAodfWG9IJ62Lj3AqxU9qfm1sDWQ1dh5/GbsHTjYcgra2Z+znAiUDHlSw+/7CEwPImRt0BXFnMeQneMr4gIHF+EwPFFCBxnhMBxQwgcX4TA8aVPAifoG1H57RAQkcqI2xhF7qIKpjLHa9Ad4ytC4PgiBI4vQuA4IwSOG0Lg+CIEji89CBybESkYfOiO8RUhcHyxTxaqEDiuCIHjhhA4vogsVL4MkyxUViYEgw/dMb4iBI4v9hE4e0QKhcBxRggcN4TA8UUIHF96EDh2OE8w+NAd4ytC4PgihlD5IgSOM0LguGEbgRNDqFyxzxCq9esUETiOYKHe4PhiGB2aCKND4g0EKG3B8aUQpLxp6PMQumN8RQgcX4TA8UUIHGeEwHHDNgInInBcGSYCx0aDBH0j0J0FJ68/4SkjQicyIMGxRcx5CN0xviLKiPBFCBxfhMBxRggcN2wjcCICxxX7CJx1gMdU4CZ1riKPdS2zyWNrx3IY2zoH8sonQEltm6cWHFLTNBNmLd1GtrHsCD62z14L0+ZtIMfS1x7OZBePM9SB233iAUbgEPo8hO4YXxECxxchcHwRAscZIXDcEALHFyFwfOlB4NjhvG2Hr8G63edgytz1ZIWFPadukbb8ylZYtP4gxKQUQ/O0peTY1o4VkJRVBfkVLdAyfTlpGz95IUxQtrEuHH3t4Ux0cgFc+9JrHsa3zWeGUhH6PITuGF8RQ6h8EUkMfBECxxkhcNywjcCJIVSuDJMkBlYmBH0jPLMZapo64dyDz8K+07cZcUMis1uZ8xC6Y3xFCBxfhMDxRQgcZ4TAcUMIHF+EwPFFCNwgEpZSC+Hp4yEis8EAtoWlVDPHa9Ad4ytC4PgiBI4vQuA4IwSOG0Lg+CIEji9C4GwA3TG+IgSOL0Lg+CIEjjNC4LghBI4vQuD4IgTOBtAd4ytC4PgiBI4vQuA4IwSOG0Lg+CIEji9C4AYTVzoER+dCSEyegWDljy8o0rwGHEJ3jK8Igfv/27vz8Djq+47j/9g0T6G2kGXJ0uqWrPu+78OSrNuSD/m+sI3xqdhgbIINxhBIcdrwEEgIIVwhpQ0hNGlJoKFpm7akSZueIWlDStMjKSnQPk94nvZJC+Xb3/cnzXp3ZiU08sfqrP3heV7P7M7ujmfnN7vz1qxYYTHgsBhwYAw4GAYcFgMOiwG3QJKy6yUhpUCqmvplZVmr539gWJpcaGKuyvM45R4YvxhwWAw4LAYcGAMOhgGHxYDD8h1wa7Yclr6x3VJY1SXNq9ZLUXW3nT88cYO9bfX4ddK2elP4vu7Hq6T0UjvVZdR3jEn38A7PfboGt3nm6b/nnhcvlpp4i/wakWVphd6Im+EsnHtg/GLAYTHgsBhwYAw4GAYcFgMOy3fALUsrlj2T52zEldT2TH9xb6GcvPOTUt85Zi9XtwxJbkmLvTy4YX/U4xOn/1yUfvHvjoNnbOTtPHTGxtnE7hvt8pp7NsjNd35CNu6+SUJ5NbLr8G3ywdP3yf6b7pG6dv0CYO96BV1182BUwJ1/+DlPwCn345R7YPxiwGEx4LAYcGAMOBgGHBYDDst3wKkbTtwjrX0TNuSKqrrkzPnHwgHXYuIrr6xVTt39Kc/jIt14xwPSObjVPL7bBpzOW7fzmJ2u3T5pA04vHzp1Xg4bA+v22oBLzYn9MWPQLUuNPgOXXdzoiTcGHAMOiQEHxoCDYcBhMeCwLuuAI/+Si3vNdKXcdv5R2bznhCfc1PL8Ds/jlHtg/GLAYTHgsBhwYAw4GAYcFgMOiwEXB9wD4xcDDosBh8WAA2PAwTDgsBhwWAy4OOAeGL8YcFgMOCwGHBgDDoYBh8WAw2LAxQH3wPjFgMNiwGEx4MAYcDAMOCwGHBYDbgElhsoltWJYQtVro6woH5Zr00o893e4B8YvBhwWAw6LAQfGgINhwGEx4LAYcAskuaRftuw7KQ989gX5+JNf9fwPDCqtep3ncco9MH4x4LAYcFgMODAGHAwDDosBh+U74PR73JIzyjzzIw1NTH33m35nnE7PnH/UTounv/T3SpRb0hT1NSKb98b+P1Hdj1PugfGLAYfFgMNiwIEx4GAYcFgMOCzfAdfaO2EjbnTTQWnp3SD7jt1l558496CMmHn6PW2jmw/ZeU7A1XWske7h7XLklo96lnelqGzqjwq4ex78vCfeGHAMOCQGHBgDDoYBh8WAw7psA06FcqtlYN0+yS9rMxE3IY1da6VjYLNkFTbav6xQVt9n76ehp9dXZFVKbfvo1LzpqLvSLMtrkZN3PRQOOHe4qeWFsc9QugfGLwYcFgMOiwEHxoCDYcBhMeCw5hVwNA9mh0gpWS1LTKS4w21JcqGklA6Y+/FvobrnBREDDosBB8aAg2HAYTHgsBhwccA9MH4x4LAYcFgMODAGHAwDDosBh8WAiwPugfGLAYfFgMNiwIEx4GAYcFgMOCwGXBxwD4xfDDgsBhwWAw6MAQfDgMNiwGEx4BZIQkGVLH7hbln06aOy+JMHoyx6ZFIWv3iPXJsR+8t83QPjFwMOiwGHxYADY8DBMOCwGHBYDLgFsvjZ055wW/ypw3LV9x6Xq77/hCz+1oOy6Csf9jxOuQdmLkK5FeHLDDgsBhwWAw6MAQfDgMNiwGHNK+AO3PzLnnmOnYfOeObtmbzDfg+ce/62/bd45l2uPPGmvv0JG2+OxY8c9TxOuQcmls7BbXJNwtQbd15pk3SY66vW7LbXbcDpm2XA2Z0xxvygSUiv8MwLoqWhcs+8ILomKcczL4iuvjbkmRdI1wb/9X51YsZUHMW4LUiuTsr2zAuihIxKz7wgumZ5rmdeENkffmPMD5ols4TmjAF38OS9su/41NkiJ9h0Wt85bqfDmw5IUujCx4F7Js/ZL/VNySyXs7/6pGQVNtj7acD1jO6U42c/bv+6g86raOj3/HuXA0+8qa+fjw64Tx/xPE65ByaW/LLm8OXk9EJJz6uUoqp2e51n4LB4Bg6LZ+DAeAYOhmfgsHgGDmteZ+AiRQac+za6YPHX7vUGnPrOQ3LVK4/Joi+dlcXfuM/zOOUeGL8YcFgMOCwGHBgDDoYBh8WAw7rogKO5+4UnTsuiZ8/I4mdujbLoi7fJBx4+5bm/wz0wfjHgsBhwWAw4MAYcDAMOiwGHxYCLA+6B8YsBh8WAw2LAgTHgYBhwWAw4LAZcHHAPjF8MOCwGHBYDDowBB8OAw2LAYTHg4oB7YPxiwGEx4LAYcGAMOBgGHBYDDosBt0CWZVTK0hRzOWWlJCTnef6g/dIVJZKYxi/ydc8LIgYcFgMOjAEHw4DDYsBh+Q64m84+ID1rdkn38A57Pb+sTQ6c+Igcv/1+e31ww/Vy60cekfr2NeHHnLzrIcksqPcs60qSFCqWB596MayoqsMTccr9OOUeGL8YcFgMOCwGHBgDDoYBh8WAw/IdcJOnPybLM8pkbOsRqW0btQGXnFkevl0DLrekRRq71obnrd0+KTnFzZ5lXUmqWwajAu78w8954o0Bx4BDYsCBMeBgGHBYDDisyzbglAZcUnqpTOy+0QbcyKYDsiK70t6mAafT1Owq++W9ejm7qFHGt8f+KwNXipTM0qiAq2oe8MQbA44Bh8SAA2PAwTDgsBhwWJd1wJF/yzJrZGlKgeSWNEkot8oTbktTSyUxdOFMZiT3wPjFgMNiwGEx4MAYcDAMOCwGHBYDbqGlFsXmvl8E98D4xYDDYsBhMeDAGHAwDDgsBhwWAy4OuAfGLwYcFgMOiwEHxoCDYcBhMeCwGHBxwD0wfjHgsBhwWAw4MAYcDAMOiwGHxYCLA+6B8YsBh8WAw2LAgTHgYBhwWAw4LAZcHHAPjF8MOCwGHBYDDowBB8OAw2LAYTHg4oB7YPxiwGEx4LAYcGAMOBgGHBYDDst3wOWUtNlpbfu4FNf2SlnDQPi2lKyp74JztA1sk9qOcXu5qmVEQnm1nuXR+3MPjF8MOCwGHBYDDowBB8OAw2LAYfkOuKLqHjvVgGtdvVVa+jZH3d7ct0m6R3fby4lpxVEBV9E0JCNbP+hZJs3OPTB+MeCwGHBYDDgwBhwMAw6LAYflO+Bo4bkHxi8GHBYDDosBB8aAg2HAYTHgsBhwccA9MH4x4LAYcFgMODAGHAwDDosBh+U74FJK+2VJUq7nT0HRxVli4iWlbMizvRlwwcOAw2LAgTHgYBhwWAw4LN8B5w4PwnJvbwZc8DDgsBhwYAw4GAYcFgMOiwEXMO7tzYALHgYcFgMOjAEHw4DDYsBhXVTA3XL2Xjl26pwcvvE2WZZWIBV1XebyGXvbsVN3yvC6HZJTVCd5xQ2yfut+mbz5rL3t9rvvk4SUfDliHpdf0iAnTt8tt334Y56YuRK5tzcDLngYcFgMODAGHAwDDosBh3VRAbdqcIPsPXTCXj547FZZkVkqu/cft9cbO4bs9NDx03LdDTfay9kFNXb6oTs+Khn5Vfbypp0HZf/RUwy4ae7tzYALHgYcFgMOjAEHw4DDYsBhwQKuvWdc1m+9Xpo6hyWUUxEOuLGJ62Tdln32shNwp+/8FUnNLpPmzhFp6RphwEVwb28GXPAw4LAYcGAMOBgGHBYDDuuiAo7w3NubARc8DDgsBhwYAw6GAYfFgMNiwAWMe3sz4IKHAYfFgANjwMEw4LAYcFi+Ay4htdQTHYSRUnrh78oy4IKLAYfFgANjwMEw4LAYcFi+A04lF3TKitJ+AkrKbvBsZwZcMDHgsBhwYAw4GAYcFgMOa14BRwvLPTB+MeCwGHBYDDgwBhwMAw6LAYfFgIsD7oHxiwGHxYDDYsCBMeBgGHBYDDgsBlwccA+MXww4LAYcFgMOjAEHw4DDYsBhMeDigHtg/GLAYTHgsBhwYAw4GAYcFgMOy3fAnQtlyiPp6fIZ49GMDHnMeDwz03oyK8v6rPFUdrZ8zvg14+mcHOvXc3PlN4zP5+XJM8YXjGfz860vrlwpzxm/aXypoEC+bPxWYaH1fFGR9RXjq8XF8oLxYkmJ/I7xNVVaKi8Zv1tWJl83fq+8XH7f+ANVUSHfMP6wslL+yPhj4+WqKvmm8SfV1da3jG/X1MifGn9WWyvfMf68rs76C+Mv6+vlr4y/bmiQvzG+qxob5RXje01N8n3jb42/a26WHxivtrRYP2xtlb83XjP+oa1NfmT8Y3u79U/GP3d0yL8YP+7slJ8Y+4urPdubARc8DDgsBhwYAw6GAYfFgMPyHXAzxdsT0wEXFW/T4XYx8fbbs8SbDbgZ4s0G3Azxpi55vBl+4u1fVVeXZ3sz4IKHAYfFgANjwMEw4LAYcFi+Ay4y3h6bLd4AZ94uRbzpmbdvzhJvTsDFijcbcJcw3l5nwHnmBREDDosBB8aAg2HAYTHgsHwH3FzjzTn7Fo43w4m3L8wSb1+eb7wZ7xdvNuD8xpsxl3j7wSzx5gRcrHizATcdbz/t7vZsbwZc8DDgsBhwYAw4GAYcFgMOy3fAve/HpoAzb35+5+3Hzzwjzn/O77y9/cor8t9vvCFvvvSSnf9fr70m8t578s7Pfibf3blT3n37bXnv3XfxH5v6/J0358zbT6fj7d8uIuDqOsfk2uRsezk5vVC6R3ZJ+8AWe90GnB58Am5JSoFnXhAlhMo884LIBlyM+UFj39RjzA+e1BjzgseGUYz5QXJ1Qshyzw8a+8NFjPlBk5Be4ZkXRNckZXvmBZENuBjzg8Z3wF3qePN75u0nkQE3febtR/ffL//785/bM28abnrm7fWnn7Zn3v7z1VdtwP3PW2/NfuZtDh+bKsTHpk68vXERAdc9uksSV+TayzWtw9LSu1GyC+vklxJDdp6+EREREdHlYbaz7TMGXKx4U7PF23w/NlUzxZt+bBoZcM7Hpq8/95z8x8sv23DTgNPfe3vvnXfkzeeflx+ePGkDDhFvqI9NnXh7c9Uqz/aea8ARERERqZgBF/OrQpxwmyHe5nLmzc/HpvP6qpCaGs/vvAXlY9M3TLhpvL3FgCMiIqKLNGPAxYq3mc68zSXeYp15m+1j07n+36ZB/aqQWGfeNN7+vafHs70ZcERERORHzIDz87Hp/1e8zev/Np3jx6aXMt4YcERERHSxYgbc/ox8edz90WmMeLtUv/N2SeJtDl8Vcql+501puL3W1S1FGSWe7a3S6zcSEfmWVj3umUc0X9yf4kfMgCMiIiKi4GLAEREREcUZBhwRERFRnGHABdjSplb5xaM7wteTQrF/fy45s9xOyxoGJDWnWlZkV9nrqTlV0rJ6i0zs/ZCM7Thu55U3Dkpxba+M77xJUrIq7H0qmoYkLbdGElOLJaekxd6vrX+rnS5PL/X8e0qXm5ha5Jk/m2VpxXYayquVtJwaWZFV6bnPfLWa9XWvT3JGWdR1fb7ux81Gl7dqzR673XW7+X186vQ4xJIUKpX0/LqoeSmZFZJotlFyxtR46nWddo3sstPk6etugxMHPc/9/Tj7UsbKesksaJzTc3P2M6X7mft2peMQeV33J+d5qOziFrvP6T7qPP/ckla7Dnq5Y2iH9K3bL6X1/fb6hr23hB/bM7ZXqlpG7L43sOGgXUZxTU94XUa2HA1v86rW0fDrQPfvyHWKpXHVBjvtHd9np7mlrZJR0GDXcUV2pYTya2W52Z/qu9aZZY9Ifnm7rBrbI53DO+169a29XgY3HpLRrZOeZbuNbJm046/bRv+NVWuuk5a+TVJat1rWbDsmvWZ5HcO6Ha63694xuMPuA85+MZOK5iEZ3TL17y+LeK+oahuVse1Tr/+5yipq8sxLiXi96jZx3x6pf/2BqeUUNtnXu/t21bhqwjNPFVRG/71oXVbk85lN//ob7P7Rt3afvey+fTax1hP5HhVJ9y+d6n7gvm0hpOfXe+bF0mq2ZeTrnoKFARdgCWV18oGn7ghfbxvYJnXmAKIHycg4iDxA6gFBp86Lzgm4bYfukOyiZhsBJbV99rpz0HYOcHpdD1LOMlSJib0tB26PWq9Mc7su1zlwhkz85ZgDs86LvJ8ejOu71ptwc2LhwnJXVnTa6dDmIzbs8ss7wrfpQbOyedgcxFfboNF5kQfhdrMd9DFOhDgHf4fzxl3bPmanzno6caGxowfqyAOFHpwGTAg1dG+Q7YfPheevGr3OTiOfmz4+r6w9fF3fjGvaxqTXHDT0wK7rVtcxHhEWkyaEy+wBXq8XVk99F2C6iafmvs3h5WgM6FQP1HrgcMbD2Qa6/u6Dksa4BpyzD+iBN6uw0f6bkfdrMIGi29yJGue5J5lA1wjSy13Du+x65pa2RT3Wofuec1mfW1PPRrvO+nz14KfrrevY1DMR3tbOODucA1bL9PPWENB107HU/dO5X0FVt902GnDdZgx0f9Z109t0++vzrOtcG14XfT46bs7rIkuXNR21um9GroPSA/xMBya9v0aZXi43PxSFQ9NslzxDH6tjs9qMha6jPlfdz3U76li4l9fYEx0qw5uOTM03AaPrrdtrePp1oPfV17kGnf4QpT9YaZiurOjwBH+suNCA03XU/VGv67ZabYJ4aNNhz30j6TZ09ldn+2qsVppgdt83ko6Bvm50v3KiRE29v1TaZWUWRr8+Hfr89f1I10+fs9L9QLeJLq9/w9S21DiOfJy+/nWq7xm67+gPIc5tGnr6mik0+48T4zPR7an7v33eZj11H+42MZ1XFnv/zy1tN+t0wK6fjo8+L41u9/2U7vf6/PW9qda8F+hro3d8ap9SzvuHs830eTj7nL6/upendDk61fdn53WsdJ2GNh62kd/WP7Uds4svvJbcdEycgNN9WMdZt0NT70a7DH2dDW8+avbtTXbbuLc/BQcDLo5EvmjdyhsHoq43mAOK+z5zVd22xjMvyOJtfZ034rmIt+dGtFA0mt3zFpL7B8dI7h9cLrVO88Ny1/QPgHTlYMARERERxRkGHBEREVGcYcARERERxZn/A2z2k67OfFqiAAAAAElFTkSuQmCC>