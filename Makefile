# The compiler
CC = clang

# Compiler flags for bare-metal WebAssembly
# --target=wasm32 tells clang we want wasm output
# -nostdlib strips out all the standard library garbage you don't need
# -O3 optimizes for speed and size
CFLAGS = --target=wasm32 -fno-builtin -nostdlib -static -Os -msimd128 -D__EMSCRIPTEN__ -I./cglm/include -I./goyslopless-c/include/ -std=gnu99 
# Linker flags passed through Clang to wasm-ld
# --no-entry: We don't have a standard main() entry point for an OS
# --export-all: Makes all your C functions available to JavaScript
# --allow-undefined: Crucial for WebGL. Allows you to call JS/WebGL functions from C even if they aren't defined at compile time.
LDFLAGS = -fuse-ld=/usr/bin/wasm-ld-19 -Wl,--no-entry -Wl,--import-undefined

# The target output
TARGETS = main.wasm benchmark.wasm
LIBS-SRC = goyslopless-c/lib/*.c

# Default rule
all: $(TARGETS)


main.wasm: $(LIBS-SRC) main.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o main.wasm main.c -Wl,--export-all $(LIBS-SRC)

benchmark.wasm: $(LIBS-SRC) benchmark.c
	$(CC) $(CFLAGS) -I./ubench $(LDFLAGS) -o benchmark.wasm benchmark.c -Wl,--export=main $(LIBS-SRC)
	wasm-opt -Os --asyncify benchmark.wasm -o benchmark.wasm

# Clean rule
clean:
	rm -f $(TARGETS)

.PHONY: clean all
