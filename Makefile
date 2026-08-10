CC = clang

CFLAGS = --target=wasm32 -fno-builtin -nostdlib -static -Os -msimd128 -matomics -mbulk-memory -D__EMSCRIPTEN__ -I./cglm/include -I./goyslopless-c/include/ -std=gnu99
# --allow-undefined: Nessecary for WebGL
# -fuse-ld=lld: use the LLVM linker bundled with clang (portable - the old
# hardcoded /usr/bin/wasm-ld path only existed on the original author's
# Linux machine).
LDFLAGS = -fuse-ld=lld -Wl,--no-entry -Wl,--import-undefined

TARGETS = main.wasm benchmark.wasm replay_worker.wasm
LIBS-SRC = goyslopless-c/lib/*.c

MAIN-EXPORTS = set_screen_dimensions set_map_bounds get_vs_main_ptr get_fs_main_ptr get_vs_grid_ptr get_fs_grid_ptr init_engine init_gl_programs ensure_agent_capacity update_frame_data render_frame apply_zoom pan_camera set_key_state
BENCHMARK-EXPORTS = main

# replay_worker.wasm: the multithreaded (-DWASM_THREADS -DSQLITE_THREADSAFE=1)
# SQLite-backed replay engine. --shared-memory/--import-memory so every
# Worker instance maps the same physical linear memory (real WASM threads,
# not a single-writer-then-freeze workaround); --initial-memory/--max-memory
# reserve the whole fixed layout from wasm_layout.h up front so no thread
# ever calls memory.grow (see heap.c) - sized against the real ~164MB/
# 15-battle replay file this project targets, tune via the benchmark suite
# if a real file exhausts a region.
WORKER-EXPORTS = thread_main \
                 replay_begin_load replay_get_load_chunk_ptr replay_feed_chunk replay_finish_load \
                 replay_get_last_error \
                 replay_get_match_count replay_get_match_start_time replay_get_match_end_time \
                 replay_get_match_scene_no replay_get_match_faction_ptr \
                 replay_get_total_start_time replay_get_total_end_time \
                 replay_advance_to_time replay_seek_to_time \
                 replay_get_frame_buffer_ptr replay_get_frame_count \
                 replay_get_active_match_index replay_get_relative_time \
                 replay_get_new_chat_count replay_get_chat_username_ptr replay_get_chat_message_ptr \
                 replay_get_chat_team replay_advance_chat_cursor \
                 replay_reader_compute_bounds replay_combine_bounds \
                 replay_get_map_min_x replay_get_map_max_x replay_get_map_min_y replay_get_map_max_y \
                 replay_ensure_battle_ready replay_prefetch_battle replay_debug_index_visible \
                 replay_get_match_start_tick_id replay_get_match_end_tick_id \
                 wasm_debug_heap_base wasm_debug_region_a_base wasm_debug_region_c_base wasm_debug_layout_end \
                 wasm_debug_stack_pool_base wasm_debug_tls_pool_base \
                 wasm_vfs_get_lock_trace wasm_vfs_get_io_trace wasm_vfs_reset_traces \
                 wasm_vfs_debug_shared_count wasm_vfs_debug_exclusive_kind
# 1GB: 256MB loader heap + 8*24MB reader/playback heaps (192MB) + 320MB
# Region A (DB blob + index overhead) + 8MB Region C, rounded up with
# headroom (see goyslopless-c/include/wasm_layout.h) - the loader's heap
# specifically had to grow from an initial 24MB after empirically hitting
# OOM building CREATE INDEX over a real 2.3M-row agent_states table.
WORKER-MEMORY-FLAGS = -Wl,--shared-memory,--import-memory -Wl,--initial-memory=1073741824 -Wl,--max-memory=1073741824
WORKER-BOOTSTRAP-EXPORTS = -Wl,--export=__stack_pointer -Wl,--export-if-defined=__wasm_init_tls

MAIN-FLAGS = $(CFLAGS) $(LDFLAGS) $(LIBS-SRC) $(shell echo $(MAIN-EXPORTS) | xargs -n 1 printf '-Wl,--export=%s ')
# benchmark.wasm links plain (non-threaded) SQLite too, for the
# Allocator.*/SQLite.* UBENCH suites - single-connection, growable-buffer
# VFS mode is all those need (they're A/B timing comparisons, not a
# concurrency test - real multi-worker parallelism is exercised separately
# by benchmark.html's JS-level system-benchmark panel against the actual
# replay_worker.wasm).
BENCHMARK-FLAGS = -DSQLITE_OS_OTHER=1 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION \
                  $(CFLAGS) $(LDFLAGS) -I./sqlite3 $(LIBS-SRC) \
                  $(shell echo $(BENCHMARK-EXPORTS) | xargs -n 1 printf '-Wl,--export=%s ')
WORKER-FLAGS = -DWASM_THREADS -DWASM_VFS_LOCK_TRACE -DSQLITE_OS_OTHER=1 -DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION \
               $(CFLAGS) $(LDFLAGS) $(WORKER-MEMORY-FLAGS) $(WORKER-BOOTSTRAP-EXPORTS) $(LIBS-SRC) \
               $(shell echo $(WORKER-EXPORTS) | xargs -n 1 printf '-Wl,--export=%s ')

#-Wl,--export-all

all: $(TARGETS)

main.wasm: $(LIBS-SRC) main.c
	$(CC) $(MAIN-FLAGS) -o main.wasm main.c

benchmark.wasm: $(LIBS-SRC) sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c benchmark.c
	$(CC) $(BENCHMARK-FLAGS) -I./ubench -o benchmark.wasm sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c benchmark.c
	wasm-opt -Os --asyncify benchmark.wasm -o benchmark.wasm

replay_worker.wasm: $(LIBS-SRC) sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c sqlite3/sqlite3_mutex_wasm.c replay_worker.c
	$(CC) $(WORKER-FLAGS) -I./sqlite3 -o replay_worker.wasm sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c sqlite3/sqlite3_mutex_wasm.c replay_worker.c

clean:
	rm -f $(TARGETS)

.PHONY: clean all
