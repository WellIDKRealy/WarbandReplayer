CC = clang

CFLAGS = --target=wasm32 -fno-builtin -nostdlib -static -Os -msimd128 -D__EMSCRIPTEN__ -I./cglm/include -I./goyslopless-c/include/ -std=gnu99 
# --allow-undefined: Nessecary for WebGL
LDFLAGS = -fuse-ld=/usr/bin/wasm-ld -Wl,--no-entry -Wl,--import-undefined

TARGETS = main.wasm benchmark.wasm sqlite3.wasm
LIBS-SRC = goyslopless-c/lib/*.c

MAIN-EXPORTS = set_screen_dimensions set_map_bounds get_vs_main_ptr get_fs_main_ptr get_vs_grid_ptr get_fs_grid_ptr init_engine init_gl_programs get_agent_buffer_ptr update_frame_data render_frame apply_zoom
BENCHMARK-EXPORTS = main
SQLITE3-EXPORTS = sqlite3_open sqlite3_exec sqlite3_close sqlite3_free malloc free

MAIN-FLAGS = $(CFLAGS) $(LDFLAGS) $(LIBS-SRC) $(shell echo $(MAIN-EXPORTS) | xargs -n 1 printf '-Wl,--export=%s ')
BENCHMARK-FLAGS = $(CFLAGS) $(LDFLAGS) $(LIBS-SRC) $(shell echo $(BENCHMARK-EXPORTS) | xargs -n 1 printf '-Wl,--export=%s ')
SQLITE3-FLAGS = -DSQLITE_OS_OTHER=1 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION $(CFLAGS) $(LDFLAGS) $(LIBS-SRC) $(shell echo $(SQLITE3-EXPORTS) | xargs -n 1 printf '-Wl,--export=%s ')

#-Wl,--export-all

all: $(TARGETS)

main.wasm: $(LIBS-SRC) main.c
	$(CC) $(MAIN-FLAGS) -o main.wasm main.c 

benchmark.wasm: $(LIBS-SRC) benchmark.c
	$(CC) $(BENCHMARK-FLAGS) -I./ubench -o benchmark.wasm benchmark.c 
	wasm-opt -Os --asyncify benchmark.wasm -o benchmark.wasm

sqlite3.wasm: $(LIBS-SRC) sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c
	$(CC) $(SQLITE3-FLAGS) -I./sqlite3 -o sqlite3.wasm sqlite3/sqlite3.c sqlite3/sqlite3_vfs_mem.c

clean:
	rm -f $(TARGETS)

.PHONY: clean all
