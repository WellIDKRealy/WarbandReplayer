#ifndef _MATH_H_
#define _MATH_H_

float fabs(float x);
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
