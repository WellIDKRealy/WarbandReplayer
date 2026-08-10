#include "wasm_thread.h"

#if defined(WASM_THREADS)
static _Thread_local int g_thread_id = -1;
#else
static int g_thread_id = 0;
#endif

void wasm_thread_set_id(int id) { g_thread_id = id; }
int wasm_current_thread_id(void) { return g_thread_id; }
