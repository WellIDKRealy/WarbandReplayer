#ifndef _MATH_H_
#define _MATH_H_

/* Compiler builtins so we don't need libc's own definitions of these -
 * every freestanding-capable compiler (clang/gcc) implements them. */
#define INFINITY (__builtin_inff())
#define NAN      (__builtin_nanf(""))
#define HUGE_VAL  (__builtin_huge_val())

double fabs(double x);
float fabsf(float x);
int abs(int x);

int isinf(float x);
int isnan(float x);

float floorf(float x);
float fminf(float a, float b);
float fmodf(float x, float y);
float modff(float value, float* iptr);

double sqrt(double x);
float sqrtf(float x);
float powf(float base, float exponent);

float sinf(float x);
float cosf(float x);
float tanf(float x);

float atanf(float x);
float atan2f(float y, float x);
float asinf(float x);
float acosf(float x);

#endif
