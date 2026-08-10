#ifndef _STDINT_H
#define _STDINT_H

typedef signed char        int8_t;
typedef short              int16_t;
typedef int                int32_t;
typedef long long          int64_t;

typedef unsigned char      uint8_t;
typedef unsigned short     uint16_t;
typedef unsigned int       uint32_t;
typedef unsigned long long uint64_t;

typedef long               intptr_t;
typedef unsigned long      uintptr_t;
typedef long long          intmax_t;
typedef unsigned long long uintmax_t;

/* "least"/"fast" variants (C99 7.18.1.2/7.18.1.3) - on wasm32 these just
 * alias the same-width exact types. Needed transitively by clang's own
 * bundled <stdatomic.h>, which declares atomic_int_least16_t & co. */
typedef int8_t    int_least8_t;
typedef uint8_t    uint_least8_t;
typedef int16_t   int_least16_t;
typedef uint16_t   uint_least16_t;
typedef int32_t   int_least32_t;
typedef uint32_t   uint_least32_t;
typedef int64_t   int_least64_t;
typedef uint64_t   uint_least64_t;

typedef int32_t   int_fast8_t;
typedef uint32_t   uint_fast8_t;
typedef int32_t   int_fast16_t;
typedef uint32_t   uint_fast16_t;
typedef int32_t   int_fast32_t;
typedef uint32_t   uint_fast32_t;
typedef int64_t   int_fast64_t;
typedef uint64_t   uint_fast64_t;

#ifndef _WCHAR_T_DEFINED
#define _WCHAR_T_DEFINED
typedef int wchar_t;
#endif

/* Integer constant macros (C99 7.18.4). Needed for literals like
 * UINT64_C(0x8000000000000000) used e.g. by SQLite's fixed-point tables,
 * which otherwise get parsed as a call to an undeclared function and
 * rejected as a non-constant initializer. */
#define INT8_C(v)   (v)
#define INT16_C(v)  (v)
#define INT32_C(v)  (v)
#define INT64_C(v)  (v ## LL)
#define UINT8_C(v)  (v ## U)
#define UINT16_C(v) (v ## U)
#define UINT32_C(v) (v ## U)
#define UINT64_C(v) (v ## ULL)
#define INTMAX_C(v)  INT64_C(v)
#define UINTMAX_C(v) UINT64_C(v)

/* Limits (C99 7.18.2), needed by code that clamps/checks against the
 * extremes of these types. */
#define INT8_MIN   (-128)
#define INT8_MAX   127
#define UINT8_MAX  0xff
#define INT16_MIN  (-32768)
#define INT16_MAX  32767
#define UINT16_MAX 0xffff
#define INT32_MIN  (-2147483647-1)
#define INT32_MAX  2147483647
#define UINT32_MAX 0xffffffffU
#define INT64_MIN  (-9223372036854775807LL-1)
#define INT64_MAX  9223372036854775807LL
#define UINT64_MAX 0xffffffffffffffffULL

#endif
