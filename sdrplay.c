/*
 * SDRplay native API v3 backend for iridium-sniffer
 *
 * Bypasses SoapySDR to talk directly to the SDRplay API, fixing
 * device-specific issues (RSP1A bias tee segfault, etc.) and giving
 * full control over per-model settings.
 *
 * Copyright (c) 2026 CEMAXECUTER LLC
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#include <err.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#include <sdrplay_api.h>

#include "sdr.h"

extern sig_atomic_t running;
extern pid_t self_pid;
extern double samp_rate;
extern double center_freq;
extern int sdrplay_gain_val;
extern int bias_tee;
extern int verbose;

/* Driver context passed between setup/stream/close */
typedef struct {
    sdrplay_api_DeviceT device;
    sdrplay_api_DeviceParamsT *params;
    int opened;       /* API opened */
    int selected;     /* device selected */
    int initialized;  /* streaming init'd */
} sdrplay_ctx_t;

/* Select the best bandwidth enum for a given sample rate */
static sdrplay_api_Bw_MHzT pick_bandwidth(double sr)
{
    if (sr <= 300000)  return sdrplay_api_BW_0_300;
    if (sr <= 600000)  return sdrplay_api_BW_0_600;
    if (sr <= 1536000) return sdrplay_api_BW_1_536;
    if (sr <= 5000000) return sdrplay_api_BW_5_000;
    if (sr <= 6000000) return sdrplay_api_BW_6_000;
    if (sr <= 7000000) return sdrplay_api_BW_7_000;
    return sdrplay_api_BW_8_000;
}

/* Map a user-facing "gain dB" value to LNA state + IF gain reduction.
 * SDRplay uses gain reduction (higher = less gain), so we invert.
 * This is a simplified mapping; LNA states vary by model and band. */
static void set_gain(sdrplay_api_RxChannelParamsT *ch, int gain_db)
{
    /* Clamp to reasonable range */
    if (gain_db < 0)  gain_db = 0;
    if (gain_db > 59) gain_db = 59;

    /* IF gain reduction: 59 - gain_db (0 dB user gain = max reduction) */
    ch->tunerParams.gain.gRdB = 59 - gain_db;
    ch->tunerParams.gain.LNAstate = 0;  /* max LNA gain */

    /* For moderate gain settings, back off the LNA */
    if (gain_db < 20) {
        ch->tunerParams.gain.LNAstate = 4;
    } else if (gain_db < 30) {
        ch->tunerParams.gain.LNAstate = 2;
    }
}

/* ---- Stream callback ---- */
static void stream_callback(short *xi, short *xq,
                             sdrplay_api_StreamCbParamsT *params,
                             unsigned int numSamples,
                             unsigned int reset, void *cbContext)
{
    (void)params;
    (void)reset;
    (void)cbContext;

    if (!running || numSamples == 0)
        return;

    /* Allocate float IQ buffer: 2 floats per sample */
    sample_buf_t *s = malloc(sizeof(*s) + numSamples * sizeof(float) * 2);
    if (!s) return;

    s->format = SAMPLE_FMT_FLOAT;
    s->hw_timestamp_ns = 0;
    s->num = numSamples;

    float *out = (float *)s->samples;

    /* Interleave separate I/Q int16 arrays and normalize.
     * SDRplay int16 range is roughly +/- 32767 but actual dynamic
     * range is ~14 bits. Use 1/32768 for clean normalization. */
    for (unsigned int i = 0; i < numSamples; i++) {
        out[i * 2]     = xi[i] * (1.0f / 32768.0f);
        out[i * 2 + 1] = xq[i] * (1.0f / 32768.0f);
    }

    push_samples(s);
}

/* ---- Event callback ---- */
static void event_callback(sdrplay_api_EventT eventId,
                            sdrplay_api_TunerSelectT tuner,
                            sdrplay_api_EventParamsT *params,
                            void *cbContext)
{
    (void)tuner;
    (void)cbContext;

    switch (eventId) {
    case sdrplay_api_GainChange:
        if (verbose)
            fprintf(stderr, "sdrplay: gain change: gRdB=%u lnaGRdB=%u "
                    "currGain=%.1f\n",
                    params->gainParams.gRdB,
                    params->gainParams.lnaGRdB,
                    params->gainParams.currGain);
        break;

    case sdrplay_api_PowerOverloadChange:
        /* Acknowledge the overload so the API can adjust */
        if (cbContext) {
            sdrplay_ctx_t *ctx = (sdrplay_ctx_t *)cbContext;
            sdrplay_api_Update(ctx->device.dev, tuner,
                               sdrplay_api_Update_Ctrl_OverloadMsgAck,
                               sdrplay_api_Update_Ext1_None);
        }
        if (verbose) {
            const char *msg =
                (params->powerOverloadParams.powerOverloadChangeType ==
                 sdrplay_api_Overload_Detected) ? "detected" : "corrected";
            fprintf(stderr, "sdrplay: power overload %s\n", msg);
        }
        break;

    case sdrplay_api_DeviceRemoved:
        warnx("sdrplay: device removed");
        running = 0;
        kill(self_pid, SIGINT);
        break;

    case sdrplay_api_DeviceFailure:
        warnx("sdrplay: device failure");
        running = 0;
        kill(self_pid, SIGINT);
        break;

    default:
        break;
    }
}

/* ---- Device enumeration ---- */
void sdrplay_list(void)
{
    sdrplay_api_ErrT err;
    float ver = 0.0f;

    err = sdrplay_api_Open();
    if (err != sdrplay_api_Success) {
        warnx("sdrplay: cannot open API: %s",
              sdrplay_api_GetErrorString(err));
        return;
    }

    err = sdrplay_api_ApiVersion(&ver);
    if (err != sdrplay_api_Success) {
        sdrplay_api_Close();
        return;
    }

    sdrplay_api_DeviceT devices[SDRPLAY_MAX_DEVICES];
    unsigned int ndevs = 0;

    err = sdrplay_api_LockDeviceApi();
    if (err != sdrplay_api_Success) {
        sdrplay_api_Close();
        return;
    }

    err = sdrplay_api_GetDevices(devices, &ndevs, SDRPLAY_MAX_DEVICES);
    if (err != sdrplay_api_Success || ndevs == 0) {
        sdrplay_api_UnlockDeviceApi();
        sdrplay_api_Close();
        return;
    }

    for (unsigned int i = 0; i < ndevs; i++) {
        const char *model;
        switch (devices[i].hwVer) {
        case SDRPLAY_RSP1_ID:    model = "RSP1";    break;
        case SDRPLAY_RSP1A_ID:   model = "RSP1A";   break;
        case SDRPLAY_RSP1B_ID:   model = "RSP1B";   break;
        case SDRPLAY_RSP2_ID:    model = "RSP2";     break;
        case SDRPLAY_RSPduo_ID:  model = "RSPduo";   break;
        case SDRPLAY_RSPdx_ID:   model = "RSPdx";    break;
        case SDRPLAY_RSPdxR2_ID: model = "RSPdxR2";  break;
        default:                 model = "Unknown";  break;
        }
        printf("interface {value=sdrplay-%s}"
               "{display=Iridium Sniffer (SDRplay %s)}\n",
               devices[i].SerNo, model);
    }

    sdrplay_api_UnlockDeviceApi();
    sdrplay_api_Close();
}

/* ---- Device setup ---- */
void *sdrplay_setup(const char *serial)
{
    sdrplay_api_ErrT err;
    float ver = 0.0f;

    sdrplay_ctx_t *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) errx(1, "sdrplay: out of memory");

    /* Open API */
    err = sdrplay_api_Open();
    if (err != sdrplay_api_Success)
        errx(1, "sdrplay: cannot open API: %s",
             sdrplay_api_GetErrorString(err));
    ctx->opened = 1;

    /* Version check */
    err = sdrplay_api_ApiVersion(&ver);
    if (err != sdrplay_api_Success)
        errx(1, "sdrplay: cannot get API version: %s",
             sdrplay_api_GetErrorString(err));
    if (verbose)
        fprintf(stderr, "sdrplay: API version %.2f\n", ver);

    /* Enumerate devices */
    sdrplay_api_DeviceT devices[SDRPLAY_MAX_DEVICES];
    unsigned int ndevs = 0;

    err = sdrplay_api_LockDeviceApi();
    if (err != sdrplay_api_Success)
        errx(1, "sdrplay: cannot lock API: %s",
             sdrplay_api_GetErrorString(err));

    err = sdrplay_api_GetDevices(devices, &ndevs, SDRPLAY_MAX_DEVICES);
    if (err != sdrplay_api_Success || ndevs == 0)
        errx(1, "sdrplay: no devices found");

    /* Find device by serial (or use first) */
    int found = -1;
    if (serial && serial[0]) {
        for (unsigned int i = 0; i < ndevs; i++) {
            if (strcmp(devices[i].SerNo, serial) == 0) {
                found = (int)i;
                break;
            }
        }
        if (found < 0)
            errx(1, "sdrplay: device with serial '%s' not found", serial);
    } else {
        found = 0;
    }

    ctx->device = devices[found];

    /* RSPduo: force single tuner mode */
    if (ctx->device.hwVer == SDRPLAY_RSPduo_ID) {
        ctx->device.tuner = sdrplay_api_Tuner_A;
        ctx->device.rspDuoMode = sdrplay_api_RspDuoMode_Single_Tuner;
    }

    err = sdrplay_api_SelectDevice(&ctx->device);
    if (err != sdrplay_api_Success)
        errx(1, "sdrplay: cannot select device: %s",
             sdrplay_api_GetErrorString(err));
    ctx->selected = 1;

    sdrplay_api_UnlockDeviceApi();

    /* Get device parameters */
    err = sdrplay_api_GetDeviceParams(ctx->device.dev, &ctx->params);
    if (err != sdrplay_api_Success)
        errx(1, "sdrplay: cannot get device params: %s",
             sdrplay_api_GetErrorString(err));

    sdrplay_api_DevParamsT *devp = ctx->params->devParams;
    sdrplay_api_RxChannelParamsT *chp = ctx->params->rxChannelA;

    /* Sample rate and bandwidth */
    devp->fsFreq.fsHz = samp_rate;
    chp->tunerParams.bwType = pick_bandwidth(samp_rate);
    chp->tunerParams.ifType = sdrplay_api_IF_Zero;

    /* Center frequency */
    chp->tunerParams.rfFreq.rfHz = center_freq;

    /* Gain */
    set_gain(chp, sdrplay_gain_val);

    /* Disable AGC */
    chp->ctrlParams.agc.enable = sdrplay_api_AGC_DISABLE;

    /* DC and IQ correction enabled */
    chp->ctrlParams.dcOffset.DCenable = 1;
    chp->ctrlParams.dcOffset.IQenable = 1;

    /* Bias tee (device-specific) */
    if (bias_tee) {
        switch (ctx->device.hwVer) {
        case SDRPLAY_RSP1A_ID:
        case SDRPLAY_RSP1B_ID:
            chp->rsp1aTunerParams.biasTEnable = 1;
            break;
        case SDRPLAY_RSP2_ID:
            chp->rsp2TunerParams.biasTEnable = 1;
            warnx("sdrplay: RSP2 bias tee only on Antenna B port");
            break;
        case SDRPLAY_RSPduo_ID:
            chp->rspDuoTunerParams.biasTEnable = 1;
            break;
        case SDRPLAY_RSPdx_ID:
        case SDRPLAY_RSPdxR2_ID:
            devp->rspDxParams.biasTEnable = 1;
            warnx("sdrplay: RSPdx bias tee only on Antenna B port");
            break;
        default:
            warnx("sdrplay: bias tee not supported on this model");
            break;
        }
        if (verbose)
            fprintf(stderr, "sdrplay: bias tee enabled\n");
    }

    const char *model;
    switch (ctx->device.hwVer) {
    case SDRPLAY_RSP1_ID:    model = "RSP1";    break;
    case SDRPLAY_RSP1A_ID:   model = "RSP1A";   break;
    case SDRPLAY_RSP1B_ID:   model = "RSP1B";   break;
    case SDRPLAY_RSP2_ID:    model = "RSP2";     break;
    case SDRPLAY_RSPduo_ID:  model = "RSPduo";   break;
    case SDRPLAY_RSPdx_ID:   model = "RSPdx";    break;
    case SDRPLAY_RSPdxR2_ID: model = "RSPdxR2";  break;
    default:                 model = "Unknown";  break;
    }
    fprintf(stderr, "sdrplay: %s serial=%s sr=%.0f freq=%.0f bw=%d gain=%d\n",
            model, ctx->device.SerNo, samp_rate, center_freq,
            (int)chp->tunerParams.bwType, sdrplay_gain_val);

    return ctx;
}

/* ---- Streaming thread ---- */
void *sdrplay_stream_thread(void *arg)
{
    sdrplay_ctx_t *ctx = (sdrplay_ctx_t *)arg;
    sdrplay_api_ErrT err;

    /* Set up callbacks */
    sdrplay_api_CallbackFnsT cbFns;
    cbFns.StreamACbFn = stream_callback;
    cbFns.StreamBCbFn = stream_callback;  /* unused for single tuner */
    cbFns.EventCbFn = event_callback;

    /* Init starts streaming immediately */
    err = sdrplay_api_Init(ctx->device.dev, &cbFns, ctx);
    if (err != sdrplay_api_Success)
        errx(1, "sdrplay: cannot init streaming: %s",
             sdrplay_api_GetErrorString(err));
    ctx->initialized = 1;

    if (verbose)
        fprintf(stderr, "sdrplay: streaming started\n");

    /* Block until told to stop. Callbacks deliver samples. */
    while (running)
        usleep(100000);

    running = 0;
    kill(self_pid, SIGINT);

    return NULL;
}

/* ---- Cleanup ---- */
void sdrplay_close(void *arg)
{
    sdrplay_ctx_t *ctx = (sdrplay_ctx_t *)arg;
    if (!ctx) return;

    if (ctx->initialized) {
        sdrplay_api_Uninit(ctx->device.dev);
        ctx->initialized = 0;
    }
    if (ctx->selected) {
        sdrplay_api_ReleaseDevice(&ctx->device);
        ctx->selected = 0;
    }
    if (ctx->opened) {
        sdrplay_api_Close();
        ctx->opened = 0;
    }

    free(ctx);
}
