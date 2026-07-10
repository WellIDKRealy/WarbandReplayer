# The compiler
CC = clang

# Compiler flags for bare-metal WebAssembly
# --target=wasm32 tells clang we want wasm output
# -nostdlib strips out all the standard library garbage you don't need
# -O3 optimizes for speed and size
CFLAGS = --target=wasm32 -fno-builtin -nostdlib -static -Os -msimd128 -I./cglm/include -I./goyslopless-c/include/ -std=c99
# Linker flags passed through Clang to wasm-ld
# --no-entry: We don't have a standard main() entry point for an OS
# --export-all: Makes all your C functions available to JavaScript
# --allow-undefined: Crucial for WebGL. Allows you to call JS/WebGL functions from C even if they aren't defined at compile time.
LDFLAGS = -fuse-ld=/usr/bin/wasm-ld-19 -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined

# The target output
TARGET = main.wasm
SRC = main.c goyslopless-c/lib/math.c

# Default rule
all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $^

# Clean rule
clean:
	rm -f $(TARGET)

.PHONY: clean all
