#include <stdint.h>

/*
 * This freestanding build has no compiler-rt linked in, so any operation
 * clang can't lower to native wasm32 instructions becomes an unresolved
 * "env.<symbol>" import (confirmed empirically: SQLite's overflow-safe
 * i64 multiply uses `__int128`, which wasm32 has no native instruction
 * for, so clang emits a call to __multi3). Implemented here instead of
 * pulling in the real compiler-rt, consistent with this project's
 * from-scratch libc.
 *
 * Must avoid ever performing __int128 *multiplication* internally (that
 * would just recurse back into __multi3) - built up from plain 32/64-bit
 * native multiplies instead, composing the 128-bit result with shifts/or
 * only (shifting and combining wide integers doesn't need a runtime call).
 */

typedef __int128 i128;
typedef unsigned __int128 u128;
typedef struct { uint64_t lo, hi; } wide128;

/* 64x64 -> 128 widening multiply via four native 32x32->64 partial
 * products (classic schoolbook) - every `*` here is between 32-bit halves
 * promoted to uint64_t, which is a plain native i64.mul, no libcall. */
static wide128 mul64x64(uint64_t a, uint64_t b) {
    uint32_t a_lo = (uint32_t)a, a_hi = (uint32_t)(a >> 32);
    uint32_t b_lo = (uint32_t)b, b_hi = (uint32_t)(b >> 32);

    uint64_t p00 = (uint64_t)a_lo * b_lo;
    uint64_t p01 = (uint64_t)a_lo * b_hi;
    uint64_t p10 = (uint64_t)a_hi * b_lo;
    uint64_t p11 = (uint64_t)a_hi * b_hi;

    uint64_t mid = (p00 >> 32) + (uint32_t)p01 + (uint32_t)p10;

    wide128 r;
    r.lo = (p00 & 0xFFFFFFFFu) | (mid << 32);
    r.hi = p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
    return r;
}

i128 __multi3(i128 a, i128 b) {
    u128 ua = (u128)a, ub = (u128)b;
    uint64_t a_lo = (uint64_t)ua, a_hi = (uint64_t)(ua >> 64);
    uint64_t b_lo = (uint64_t)ub, b_hi = (uint64_t)(ub >> 64);

    wide128 core = mul64x64(a_lo, b_lo);
    /* only the low 64 bits of the cross term matter - it lands in the
     * result's high word of a 128-bit *truncated* product - so this is a
     * plain native u64*u64 truncating multiply, not a widening one. */
    uint64_t cross = a_lo * b_hi + a_hi * b_lo;

    u128 result = ((u128)(core.hi + cross) << 64) | core.lo;
    return (i128)result;
}
