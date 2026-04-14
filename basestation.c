/*
 * BaseStation (SBS) format output for aircraft position feeds
 *
 * Runs a TCP server that accepts connections and writes MSG,3 lines
 * whenever an aircraft position is decoded. Compatible with VRS,
 * tar1090, PlanePlotter, and other tools that consume SBS data.
 *
 * Copyright (c) 2026 CEMAXECUTER LLC
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

#include <arpa/inet.h>
#include <errno.h>
#include <err.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "aircraft_db.h"
#include "basestation.h"

extern volatile int running;

#define BS_MAX_CLIENTS 16

static int listen_fd = -1;
static int clients[BS_MAX_CLIENTS];
static int n_clients = 0;
static pthread_mutex_t clients_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_t accept_thread;
static int bs_active = 0;
static int bs_mode = 0;  /* 0 = server, 1 = client (push) */
static char *bs_remote_host = NULL;
static int bs_remote_port = 0;
static int bs_client_fd = -1;
static pthread_t reconnect_thread;

static void set_nonblocking(int fd)
{
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0)
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/*
 * Accept thread: listens for incoming connections from tracking tools
 * (VRS, tar1090, etc.) and adds them to the client list.
 */
static void *bs_accept_thread(void *arg)
{
    (void)arg;

    while (running) {
        struct sockaddr_in client_addr;
        socklen_t addr_len = sizeof(client_addr);

        /* Use a timeout so the thread checks 'running' periodically */
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(listen_fd, &rfds);
        struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };

        int ret = select(listen_fd + 1, &rfds, NULL, NULL, &tv);
        if (ret <= 0) continue;

        int client_fd = accept(listen_fd, (struct sockaddr *)&client_addr,
                                &addr_len);
        if (client_fd < 0) continue;

        set_nonblocking(client_fd);

        /* Disable Nagle for low-latency writes */
        int one = 1;
        setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

        pthread_mutex_lock(&clients_lock);
        if (n_clients < BS_MAX_CLIENTS) {
            clients[n_clients++] = client_fd;
            char addr_str[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &client_addr.sin_addr, addr_str,
                      sizeof(addr_str));
            fprintf(stderr, "basestation: client connected from %s:%d "
                    "(%d active)\n", addr_str, ntohs(client_addr.sin_port),
                    n_clients);
        } else {
            fprintf(stderr, "basestation: max clients reached, "
                    "rejecting connection\n");
            close(client_fd);
        }
        pthread_mutex_unlock(&clients_lock);
    }

    return NULL;
}

/*
 * Client mode: connect to a remote host and push SBS data.
 * Reconnects automatically if the connection drops.
 */
static int bs_client_connect(void)
{
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(bs_remote_port),
    };

    if (inet_pton(AF_INET, bs_remote_host, &addr.sin_addr) != 1) {
        /* Try DNS resolution */
        struct hostent *he = gethostbyname(bs_remote_host);
        if (!he) {
            close(fd);
            return -1;
        }
        memcpy(&addr.sin_addr, he->h_addr_list[0], he->h_length);
    }

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }

    set_nonblocking(fd);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    return fd;
}

static void *bs_reconnect_thread(void *arg)
{
    (void)arg;

    while (running) {
        pthread_mutex_lock(&clients_lock);
        int need_connect = (bs_client_fd < 0);
        pthread_mutex_unlock(&clients_lock);

        if (need_connect) {
            int fd = bs_client_connect();
            if (fd >= 0) {
                pthread_mutex_lock(&clients_lock);
                bs_client_fd = fd;
                clients[0] = fd;
                n_clients = 1;
                pthread_mutex_unlock(&clients_lock);
                fprintf(stderr, "basestation: connected to %s:%d\n",
                        bs_remote_host, bs_remote_port);
            }
        }

        /* Check every 5 seconds */
        for (int i = 0; i < 10 && running; i++)
            usleep(500000);
    }

    return NULL;
}

int basestation_init(const char *endpoint)
{
    int port = 30003;
    char *host = NULL;

    if (endpoint && endpoint[0]) {
        char *ep = strdup(endpoint);
        char *colon = strrchr(ep, ':');
        if (colon && colon != ep) {
            /* HOST:PORT -- client (push) mode */
            *colon = '\0';
            host = strdup(ep);
            port = atoi(colon + 1);
        } else if (colon == ep) {
            /* :PORT -- server mode */
            port = atoi(colon + 1);
        } else {
            /* Just a number -- server mode on that port */
            port = atoi(ep);
        }
        free(ep);
    }

    if (port <= 0 || port > 65535) {
        warnx("basestation: invalid port %d", port);
        free(host);
        return -1;
    }

    memset(clients, -1, sizeof(clients));
    n_clients = 0;
    bs_active = 1;

    if (host) {
        /* Client mode: push to remote host */
        bs_mode = 1;
        bs_remote_host = host;
        bs_remote_port = port;

        int fd = bs_client_connect();
        if (fd >= 0) {
            bs_client_fd = fd;
            clients[0] = fd;
            n_clients = 1;
            fprintf(stderr, "basestation: connected to %s:%d\n",
                    host, port);
        } else {
            fprintf(stderr, "basestation: cannot connect to %s:%d "
                    "(will retry)\n", host, port);
        }

        pthread_create(&reconnect_thread, NULL, bs_reconnect_thread, NULL);

        fprintf(stderr, "basestation: pushing SBS feed to %s:%d\n",
                host, port);
    } else {
        /* Server mode: accept incoming connections */
        bs_mode = 0;

        listen_fd = socket(AF_INET, SOCK_STREAM, 0);
        if (listen_fd < 0) {
            warn("basestation: socket");
            return -1;
        }

        int reuse = 1;
        setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

        struct sockaddr_in addr = {
            .sin_family = AF_INET,
            .sin_addr.s_addr = INADDR_ANY,
            .sin_port = htons(port),
        };

        if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
            warn("basestation: bind port %d", port);
            close(listen_fd);
            listen_fd = -1;
            return -1;
        }

        if (listen(listen_fd, 4) < 0) {
            warn("basestation: listen");
            close(listen_fd);
            listen_fd = -1;
            return -1;
        }

        pthread_create(&accept_thread, NULL, bs_accept_thread, NULL);

        fprintf(stderr, "basestation: SBS feed on port %d "
                "(connect VRS/tar1090 to this port)\n", port);
    }

    return 0;
}

void basestation_send_position(const char *reg, const char *flight,
                                double lat, double lon,
                                int alt_ft, uint64_t timestamp_ns)
{
    if (!bs_active || !reg || !reg[0])
        return;

    /* Look up ICAO hex from registration */
    const char *hex = aircraft_db_lookup(reg);
    if (!hex) return;  /* unknown aircraft, skip */

    /* Format timestamp */
    time_t now = time(NULL);
    struct tm tm;
    gmtime_r(&now, &tm);
    char datestamp[32], timestamp[32];
    strftime(datestamp, sizeof(datestamp), "%Y/%m/%d", &tm);
    strftime(timestamp, sizeof(timestamp), "%H:%M:%S.000", &tm);

    /* Build MSG,3 line */
    char msg[512];
    int len;
    /* SBS MSG,3 format (22 fields):
     * MSG,3,SessionID,AircraftID,HexIdent,FlightID,
     * DateGen,TimeGen,DateLog,TimeLog,
     * Callsign,Alt,GS,Track,Lat,Lon,VR,
     * Squawk,Alert,Emergency,SPI,IsOnGround */
    if (alt_ft > -99999) {
        len = snprintf(msg, sizeof(msg),
            "MSG,3,1,1,%s,1,%s,%s,%s,%s,%s,%d,,,%.6f,%.6f,,,,,,0\r\n",
            hex, datestamp, timestamp, datestamp, timestamp,
            (flight && flight[0]) ? flight : "",
            alt_ft, lat, lon);
    } else {
        len = snprintf(msg, sizeof(msg),
            "MSG,3,1,1,%s,1,%s,%s,%s,%s,%s,,,,%.6f,%.6f,,,,,,0\r\n",
            hex, datestamp, timestamp, datestamp, timestamp,
            (flight && flight[0]) ? flight : "",
            lat, lon);
    }

    if (len <= 0 || len >= (int)sizeof(msg))
        return;

    /* Write to all connected clients / remote host */
    pthread_mutex_lock(&clients_lock);
    for (int i = 0; i < n_clients; ) {
        ssize_t written = write(clients[i], msg, len);
        if (written < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
            close(clients[i]);
            if (bs_mode == 1) {
                /* Client mode: mark for reconnection */
                bs_client_fd = -1;
                n_clients = 0;
                fprintf(stderr, "basestation: connection to %s:%d lost "
                        "(will reconnect)\n",
                        bs_remote_host, bs_remote_port);
            } else {
                clients[i] = clients[--n_clients];
                fprintf(stderr, "basestation: client disconnected "
                        "(%d active)\n", n_clients);
            }
            break;
        } else {
            i++;
        }
    }
    pthread_mutex_unlock(&clients_lock);
}

void basestation_destroy(void)
{
    if (!bs_active) return;
    bs_active = 0;

    if (bs_mode == 1) {
        pthread_join(reconnect_thread, NULL);
    } else {
        if (listen_fd >= 0) {
            close(listen_fd);
            listen_fd = -1;
        }
        pthread_join(accept_thread, NULL);
    }

    pthread_mutex_lock(&clients_lock);
    for (int i = 0; i < n_clients; i++)
        close(clients[i]);
    n_clients = 0;
    if (bs_client_fd >= 0) {
        close(bs_client_fd);
        bs_client_fd = -1;
    }
    pthread_mutex_unlock(&clients_lock);

    free(bs_remote_host);
    bs_remote_host = NULL;
}
