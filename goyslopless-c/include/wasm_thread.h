#ifndef _WASM_THREAD_H
#define _WASM_THREAD_H

/* Ambient "which worker am I" identity, set once by thread_main() right
 * after a worker's TLS/stack bootstrap completes. Backing storage is a
 * real WASM TLS variable (see wasm_thread.c) under WASM_THREADS builds -
 * a plain global would alias across every worker instance sharing the
 * same WebAssembly.Memory, since linear memory (unlike wasm globals) is
 * the one thing that's genuinely shared. Used by sqlite3_mutex_wasm.c to
 * identify the current owner of a recursive mutex without SQLite's fixed
 * xMutex* signatures having any thread-id parameter to pass one through. */
void wasm_thread_set_id(int id);
int wasm_current_thread_id(void);

#endif
