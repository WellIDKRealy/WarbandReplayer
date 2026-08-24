CC = clang

CFLAGS = --target=wasm32 -fno-builtin -nostdlib -static -Os -msimd128 -matomics -mbulk-memory -D__EMSCRIPTEN__ -I./cglm/include -I./goyslopless-c/include/ -std=gnu99
# --allow-undefined: Nessecary for WebGL
# -fuse-ld=lld: use the LLVM linker bundled with clang (portable - the old
# hardcoded /usr/bin/wasm-ld path only existed on the original author's
# Linux machine).
LDFLAGS = -fuse-ld=lld -Wl,--no-entry -Wl,--import-undefined

TARGETS = main.wasm benchmark.wasm replay_worker.wasm compress.wasm
LIBS-SRC = goyslopless-c/lib/*.c
# Explicit header prerequisites - without these, `make` has no idea a .c
# file includes them, so editing e.g. wasm_layout.h alone does NOT trigger a
# rebuild (confirmed directly: Phase 6's memory-layout shrink silently built
# nothing until `rm -f replay_worker.wasm` forced it). The pre-commit hook
# forces a rebuild before every commit either way, so this was never a risk
# of shipping a stale binary - but it's a real footgun for local
# iteration (a rebuild-and-test cycle that silently tests the OLD binary).
GOYSLOPLESS-HEADERS = goyslopless-c/include/*.h
SQLITE-HEADERS = sqlite3/*.h
LZMA-HEADERS = lzma-sdk/*.h
LZMA-SRC = lzma-sdk/LzFind.c lzma-sdk/LzmaEnc.c lzma-sdk/Lzma2Enc.c lzma-sdk/Xz.c lzma-sdk/XzEnc.c \
           lzma-sdk/XzDec.c lzma-sdk/Lzma2Dec.c lzma-sdk/LzmaDec.c lzma-sdk/Delta.c \
           lzma-sdk/Bra.c lzma-sdk/Bra86.c lzma-sdk/BraIA64.c \
           lzma-sdk/XzCrc64.c lzma-sdk/XzCrc64Opt.c lzma-sdk/7zCrc.c lzma-sdk/7zCrcOpt.c \
           lzma-sdk/Sha256.c lzma-sdk/CpuArch.c

MAIN-EXPORTS = set_screen_dimensions set_map_bounds get_vs_main_ptr get_fs_main_ptr get_vs_grid_ptr get_fs_grid_ptr init_engine init_gl_programs ensure_agent_capacity update_frame_data render_frame apply_zoom pan_camera set_key_state ensure_highlight_capacity update_highlight_data get_cam_x get_cam_y set_view_shift
BENCHMARK-EXPORTS = main
COMPRESS-EXPORTS = compress_begin compress_get_input_chunk_ptr compress_feed_chunk compress_finish \
                   decompress_finish \
                   compress_get_output_ptr compress_get_output_len compress_get_last_error \
                   compress_debug_write_call_count compress_debug_write_bytes_total compress_debug_output_byte

# replay_worker.wasm: the multithreaded (-DWASM_THREADS -DSQLITE_THREADSAFE=1)
# SQLite-backed replay engine. --shared-memory/--import-memory so every
# Worker instance maps the same physical linear memory (real WASM threads,
# not a single-writer-then-freeze workaround). --initial-memory covers the
# fixed wasm_layout.h layout up front (every thread's original slab, Region
# C, stack/TLS pools); --max-memory is a genuine ceiling ABOVE that now, not
# equal to it - per-thread heaps that exhaust their original slab grow into
# this headroom via memory.grow (see heap.c's heap_extend_threaded), which
# only actually does anything useful because max > initial here. Getting
# this wrong (initial===maximum, no headroom at all) makes every grow call
# fail immediately regardless of how correct the grow logic itself is -
# caught empirically while testing this exact change.
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
                 replay_try_prime_battle replay_set_priming_budget_bytes \
                 replay_get_playback_heap_bytes replay_get_battle_ready_mask \
                 replay_get_match_start_tick_id replay_get_match_end_tick_id \
                 wasm_debug_heap_base wasm_debug_region_c_base wasm_debug_layout_end \
                 wasm_debug_stack_pool_base wasm_debug_tls_pool_base \
                 wasm_vfs_get_lock_trace wasm_vfs_get_io_trace wasm_vfs_reset_traces \
                 wasm_vfs_debug_shared_count wasm_vfs_debug_exclusive_kind \
                 heap_debug_region_count heap_debug_extend_failures heap_debug_bytes_inuse \
                 replay_get_filename_buf_ptr replay_set_filename_len replay_set_export_time_unix \
                 replay_get_source_sha256_hex replay_get_source_filename replay_get_source_size_bytes \
                 replay_export_battle replay_export_get_tar_ptr replay_export_get_tar_len \
                 replay_export_get_last_error replay_finish_load_battle_file \
                 sql_terminal_get_query_buf_ptr sql_terminal_run sql_terminal_column_count \
                 sql_terminal_column_name sql_terminal_step sql_terminal_column_is_null \
                 sql_terminal_column_text sql_terminal_get_last_error \
                 sql_checkpoint_save sql_checkpoint_revert sql_checkpoint_get_last_error \
                 replay_set_cursor_world_pos replay_get_data_generation \
                 replay_get_default_replaydb_sql replay_get_default_battledb_sql \
                 replay_get_generator_script_buf_ptr replay_run_generator_script replay_reset_generator_script \
                 replay_ensure_db_view
# Phase 6: 96MiB - 8MiB loader heap + 8*2MiB reader heaps (16MiB) + 4MiB
# prefetch heap + 4KiB Region C + ~40.6MB stack/TLS pools = ~68.6MiB of
# wasm_layout.h's own addressed regions, plus headroom for the module's
# static data (SQLite's amalgamation - lookup/opcode tables, etc.) and
# rounding. This is a real reduction from the old 640MiB, not a relabeling:
# wasm_layout.h's nominal per-thread sizes shrank too (see that file's own
# comment for why that's safe - heap_extend_threaded() already transparently
# grows any thread past its nominal slab, proven under real stress at
# exactly the loader's 8MiB floor). No more fixed DB-blob region (was
# 320MB) either, now that the source file lives in OPFS instead.
# max-memory=2GiB stays unchanged as the ceiling - real headroom above this
# much smaller initial commitment for heap_extend_threaded to grow into
# (wasm32's own 4GiB address ceiling leaves plenty of room above this too).
WORKER-MEMORY-FLAGS = -Wl,--shared-memory,--import-memory -Wl,--initial-memory=100663296 -Wl,--max-memory=2147483648
# --export-if-defined=__tls_size: lets replay-worker.js's bootstrap() verify
# the LINKER's actual computed per-thread TLS block size fits
# WASM_TLS_SLOT_SIZE (wasm_layout.h) before trusting it - nothing else
# checks this, and a _Thread_local variable added later (e.g.
# sqlite3_vfs_mem.c's OPFS page cache) that grows past the hardcoded slot
# would otherwise silently corrupt the adjacent thread's TLS block, exactly
# the class of bug wasm_stack_pool_base()/wasm_tls_pool_base() already exist
# to prevent for the stack/heap regions - this closes the same gap for TLS.
WORKER-BOOTSTRAP-EXPORTS = -Wl,--export=__stack_pointer -Wl,--export-if-defined=__wasm_init_tls -Wl,--export-if-defined=__tls_size

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
# compress.wasm: NOT threaded (no -DWASM_THREADS - plain, already-elastic
# goyslopless-c/lib/heap.c growth path, no fixed slabs to size), no SQLite
# at all. -D_7ZIP_ST builds the vendored LZMA SDK single-threaded, which
# also removes its only link-time dependency on MtCoder.c/LzFindMt.c/
# Threads.c (every call site compiles out under that flag - see
# lzma-sdk/NOTICE.md). No memory flags override needed: default
# (non-shared, growable) WebAssembly.Memory is exactly what a standalone,
# one-shot, per-battle-sized compressor needs.
#
# Deliberately does NOT use $(LDFLAGS) - that bakes in --import-undefined
# for main.wasm's WebGL imports, which for THIS module just turns any
# missing symbol into a phantom JS import that fails at instantiation time
# in the browser instead of at build time. Caught for real: adding the xz
# decoder pulled in x86_Convert/IA64_Convert (BCJ filter converters,
# referenced but never called since no filter is ever configured) and the
# build silently "succeeded" with them turned into env imports nothing
# supplies - compress-worker.js's WebAssembly.instantiate() then failed
# with "module is not an object or function". compress.wasm should never
# need ANY imports; --no-entry alone (no --import-undefined) makes that a
# hard link error again, the same class of bug wasm_stack_pool_base()/
# wasm_tls_pool_base() exist to catch for the layout math elsewhere in
# this project - undefined symbols belong at build time, not runtime.
COMPRESS-FLAGS = -D_7ZIP_ST $(CFLAGS) -fuse-ld=lld -Wl,--no-entry -I./lzma-sdk \
                 $(shell echo $(COMPRESS-EXPORTS) | xargs -n 1 printf '-Wl,--export=%s ')

#-Wl,--export-all

all: $(TARGETS)

main.wasm: $(LIBS-SRC) $(GOYSLOPLESS-HEADERS) main.c
	$(CC) $(MAIN-FLAGS) -o main.wasm main.c

benchmark.wasm: $(LIBS-SRC) $(GOYSLOPLESS-HEADERS) $(SQLITE-HEADERS) sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c benchmark.c
	$(CC) $(BENCHMARK-FLAGS) -I./ubench -o benchmark.wasm sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c benchmark.c
	wasm-opt -Os --asyncify benchmark.wasm -o benchmark.wasm

# Canonical SQL -> compiled-in C string + its own sha256 (see the script's
# own docstring for why this is generated rather than hand-copied: it's what
# keeps the C engine, testdata/ground_truth.py, and battle.db's
# _table_provenance hashes from drifting out of sync with each other).
sql/canonical_roster_corpse_sql.h: sql/canonical_roster_corpse.sql scripts/gen_canonical_sql_header.py
	python3 scripts/gen_canonical_sql_header.py sql/canonical_roster_corpse.sql sql/canonical_roster_corpse_sql.h CANONICAL_ROSTER_CORPSE

replay_worker.wasm: $(LIBS-SRC) $(GOYSLOPLESS-HEADERS) $(SQLITE-HEADERS) sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c sqlite3/sqlite3_mutex_wasm.c replay_worker.c replay_export.c sql_terminal.c replay_internal.h sql/canonical_roster_corpse_sql.h
	$(CC) $(WORKER-FLAGS) -I./sqlite3 -o replay_worker.wasm sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c sqlite3/sqlite3_mutex_wasm.c replay_worker.c replay_export.c sql_terminal.c

compress.wasm: $(LIBS-SRC) $(GOYSLOPLESS-HEADERS) $(LZMA-HEADERS) $(LZMA-SRC) compress_worker.c
	$(CC) $(COMPRESS-FLAGS) -o compress.wasm $(LIBS-SRC) $(LZMA-SRC) compress_worker.c

clean:
	rm -f $(TARGETS) sql/*_sql.h

# Ground-truth correctness suite (testdata/run_test_suite.py): drives the
# real wasm via Selenium against every fixture under testdata/replays_batch/
# and diffs each sampled frame's positions/corpses/chat against
# ground_truth.py's independent computation (never touches the wasm engine).
# Depends on $(TARGETS) so this always tests what's actually on disk, not a
# stale build from before your last edit. Needs a dev server already running
# (`python3 serve.py 8137` - see README) and `pip install selenium`; browser
# defaults to chrome (fast, no extra driver setup) - override with
# `make test BROWSERS=chrome,firefox`.
BROWSERS ?= chrome
test-correctness: $(TARGETS)
	python3 testdata/run_test_suite.py --browsers $(BROWSERS)

# UI-behavior suite (testdata/run_ui_tests.py): panel visibility/dragging,
# keyboard focus, prefetch/eviction scheduling, budget tiering. Same
# prerequisites as test-correctness above.
test-ui: $(TARGETS)
	python3 testdata/run_ui_tests.py --browsers $(BROWSERS)

test: test-correctness test-ui

.PHONY: clean all test test-correctness test-ui
