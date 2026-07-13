#ifndef _TIME_H
#define _TIME_H

#include "stddef.h"

typedef long time_t;

struct timespec {
    time_t tv_sec;
    long tv_nsec;
};

#define CLOCK_MONOTONIC 1

// Direct mapping link to the browser's performance high-resolution JavaScript layer
__attribute__((import_module("env"), import_name("clock_gettime")))
int clock_gettime(int clk_id, struct timespec *tp);

#endif
