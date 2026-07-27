/* NOTE: assert.h is intentionally NOT include-guarded against re-inclusion.
 * The C standard requires assert() to be redefinable by toggling NDEBUG and
 * re-including <assert.h> (this is exactly what happens: SQLite's amalgamation
 * decides whether NDEBUG should be defined based on SQLITE_DEBUG *before* its
 * single #include <assert.h>, so by the time we get here NDEBUG's final value
 * is already correct). We only guard the extern declaration of the failure
 * handler so *that* part doesn't get redeclared on repeat inclusion. */

#undef assert

#ifdef NDEBUG
#  define assert(expr) ((void)0)
#else

#ifndef _ASSERT_H_FAIL_DECL
#define _ASSERT_H_FAIL_DECL
extern void __assert_fail(const char *expr, const char *file, int line, const char *func);
#endif

#  define assert(expr) \
      ((expr) ? (void)0 : __assert_fail(#expr, __FILE__, __LINE__, __func__))
#endif
