#ifndef _STDLIB_H
#define _STDLIB_H

#include "stddef.h"

void *malloc(size_t size);
void *realloc(void *ptr, size_t size);
void free(void *ptr);
void exit(int status);

double atof(const char *str);

// WASM Specific
double emscripten_performance_now(void); // Ensures ubench.h sees the declaration early
void yield_thread(void);

#endif
