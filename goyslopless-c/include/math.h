#ifndef _MATH_H_
#define _MATH_H_

extern float fabs(float x);
extern float fabsf(float x);
extern int abs(int x);

extern int isinf(float x);
extern int isnan(float x);

extern float floorf(float x);
extern float fminf(float a, float b);
extern float fmodf(float x, float y);
extern float modff(float value, float* iptr);

extern float sqrtf(float x);
extern float powf(float base, float exponent);

extern float sinf(float x);
extern float cosf(float x);
extern float tanf(float x);

extern float atanf(float x);
extern float atan2f(float y, float x);
extern float asinf(float x);
extern float acosf(float x);

#endif
