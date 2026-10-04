#!/bin/bash
# Native vs wasm32-wasi speed of the per-battle pipeline (same C code, same SQLite, same inputs). Distro toolchain only:
#   apt-get install clang wasi-libc libclang-rt-18-dev-wasm32
# Usage: build.sh WORKDIR     (WORKDIR must contain sqlite3.c sqlite3.h from ../../sqlite3/)
set -e
cd "$1"
F="-O2 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_OMIT_WAL -DSQLITE_OMIT_SHARED_MEMORY -DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_OMIT_DEPRECATED -DSQLITE_ENABLE_DESERIALIZE"
clang $F -c sqlite3.c -o sqlite3_native.o
clang --target=wasm32-wasi --sysroot=/usr $F -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -DSQLITE_OMIT_POPEN -c sqlite3.c -o sqlite3_wasm.o
clang -O2 -DSQLITE_THREADSAFE=0 bench_extract.c sqlite3_native.o -o bench_native -lm -lpthread -ldl
clang --target=wasm32-wasi --sysroot=/usr -O2 bench_extract.c sqlite3_wasm.o -o bench.wasm -lwasi-emulated-getpid -lwasi-emulated-signal -lwasi-emulated-process-clocks -Wl,--max-memory=4294967296
# run:  ./bench_native DB SPANS history.sql corpses.sql
#       node --no-warnings run_wasi.js WORKDIR /work/DB /work/SPANS /work/canonical_roster_history.sql /work/canonical_corpses.sql
