#ifndef _STDLIB_H
#define _STDLIB_H

#include "stddef.h"

void *malloc(size_t size);
void *realloc(void *ptr, size_t size);
void *calloc(size_t nmemb, size_t size);
void free(void *ptr);
void exit(int status);
void abort(void);

double atof(const char *str);

#if defined(WASM_THREADS)
void heap_thread_init(int thread_id);
size_t heap_debug_bytes_inuse(void); /* current thread's live (allocated, not-yet-freed) heap bytes */
#endif

// WASM Specific
double emscripten_performance_now(void); // Ensures ubench.h sees the declaration early
void yield_thread(void);

#endif
