#ifndef _TIME_H
#define _TIME_H

#include "stddef.h"

typedef long time_t;

struct timespec {
    time_t tv_sec;
    long tv_nsec;
};

#define CLOCK_MONOTONIC 1

/* Standard broken-down time, needed by SQLite's datetime()/strftime()
 * 'localtime' modifier (sqlite3.c's toLocaltime()/osLocaltime()). */
struct tm {
    int tm_sec;
    int tm_min;
    int tm_hour;
    int tm_mday;
    int tm_mon;
    int tm_year;
    int tm_wday;
    int tm_yday;
    int tm_isdst;
};

/* NOTE: there is no timezone database in this freestanding wasm
 * environment, so "local" time is currently treated as equal to UTC
 * (tm_isdst is always 0). This is a standard simplification used by
 * many embedded/freestanding libcs when no TZ data is available. If
 * real local time is needed later, have main.c pull the browser's UTC
 * offset via JS and apply it before/after calling localtime(). */
struct tm *localtime(const time_t *timer);

// Direct mapping link to the browser's performance high-resolution JavaScript layer
__attribute__((import_module("env"), import_name("clock_gettime")))
int clock_gettime(int clk_id, struct timespec *tp);

#endif
