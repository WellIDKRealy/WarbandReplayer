#include <math.h>

typedef union {
    float f;
    unsigned int i;
} float_bits;

#define INFINITY_BITS 0x7F800000
#define SIGN_BIT_MASK 0x80000000
#define MANTISSA_MASK 0x007FFFFF
#define EXPONENT_MASK 0x7F800000

float fabs(float x) {
  float_bits u;
  u.f = x;
  u.i &= ~SIGN_BIT_MASK; // Clear the sign bit
  return u.f;
}

float fabsf(float x) {
  return fabs(x);
}

int abs(int x) {
  return (x < 0) ? -x : x;
}

int isinf(float x) {
    float_bits u;
    u.f = x;
    return (u.i & 0x7FFFFFFF) == EXPONENT_MASK;
}

int isnan(float x) {
    float_bits u;
    u.f = x;
    return ((u.i & EXPONENT_MASK) == EXPONENT_MASK) && ((u.i & MANTISSA_MASK) != 0);
}

float floorf(float x) {
    union { float f; unsigned int i; } u = {x};
    int exponent = (int)((u.i >> 23) & 0xFF) - 127;
    
    // If the exponent is greater than 22, it's already an integer (or Inf/NaN)
    if (exponent >= 23) return x; 
    if (exponent < 0) return (x < 0.0f) ? -1.0f : 0.0f;
    
    unsigned int mask = MANTISSA_MASK >> exponent;
    if ((u.i & mask) == 0) return x; // Already an integer
    
    if (u.i & SIGN_BIT_MASK) u.i += mask; // Handle negative rounding
    u.i &= ~mask;
    return u.f;
}


float fminf(float a, float b) {
    if (isnan(a)) return b;
    if (isnan(b)) return a;
    return (a < b) ? a : b;
}

float fmodf(float x, float y) {
    if (y == 0.0f || isnan(x) || isnan(y) || isinf(x)) return (x * y) / (x * y);
    if (isinf(y)) return x;

    // Fast truncated division method
    float trfn = (float)(int)(x / y);
    return x - trfn * y;
}

float modff(float value, float* iptr) {
    if (isnan(value)) {
        *iptr = value;
        return value;
    }
    if (isinf(value)) {
        *iptr = value;
        return (value < 0.0f) ? -0.0f : 0.0f;
    }
    
    int int_part = (int)value;
    *iptr = (float)int_part;
    return value - *iptr;
}

float sqrtf(float x) {
    if (x < 0.0f) return (0.0f / 0.0f);
    // This semantic pattern is safely recognized by Clang/WASM as a native instruction
    float res;
    __asm__ ("f32.sqrt %0, %1" : "=r"(res) : "r"(x)); // Optional fallback if using inline assembly
    // If inline asm is not preferred, keep a fast 4-iteration Newton-Raphson or rely on -O3 auto-lowering
    return __builtin_sqrtf(x); 
}

double sqrt(double x) {
    if (x < 0.0) return (0.0 / 0.0); // NaN
    // Safe double-to-float fallback for benchmark variance calculations
    return (double)sqrtf((float)x);
}

static float log2f_fast(float x) {
    union { float f; unsigned int i; } u = {x};
    int vx = u.i;
    int ex = (vx >> 23) - 127;
    u.i = (vx & MANTISSA_MASK) | 0x3F800000;
    
    // Minimax polynomial for log2(m) over [1,2]
    float m = u.f;
    float y = (m - 1.0f) / (m + 1.0f);
    float y2 = y * y;
    float l = y * (2.8853900f + y2 * (0.9614706f + y2 * 0.5782725f));
    return (float)ex + l;
}

static float exp2f_fast(float x) {
    if (x < -126.0f) return 0.0f;
    if (x > 127.0f) return (1.0f / 0.0f); // Inf

    int ipart = (int)floorf(x + 0.5f);
    float fpart = x - (float)ipart;

    // Polynomial approximation for 2^fpart over [-0.5, 0.5]
    float rem = 1.0f + fpart * (0.6931472f + fpart * (0.2402265f + fpart * 0.0555041f));

    union { unsigned int i; float f; } u;
    u.i = (unsigned int)((ipart + 127) << 23);
    return u.f * rem;
}

float powf(float base, float exponent) {
    if (base == 0.0f) return 0.0f;
    if (exponent == 0.0f) return 1.0f;
    
    if (base < 0.0f) {
        // Handle negative base with integer exponents safely
        if (fmodf(exponent, 1.0f) == 0.0f) {
            float abs_res = exp2f_fast(exponent * log2f_fast(-base));
            return ((int)exponent % 2 == 0) ? abs_res : -abs_res;
        }
        return (0.0f / 0.0f); // NaN
    }

    return exp2f_fast(exponent * log2f_fast(base));
}

#define PI 3.14159265358979323846f

float sinf(float x) {
    // 1. Range reduction to [-PI, PI]
    x = fmodf(x, 2.0f * PI);
    if (x > PI)  x -= 2.0f * PI;
    if (x < -PI) x += 2.0f * PI;

    // 2. High-precision minimax approximation for sin(x)
    // Coeffs optimized for absolute error over [-PI/2, PI/2]
    float x2 = x * x;
    return x * (1.0f + x2 * (-0.16666668f + x2 * (0.0083328241f + x2 * (-0.0001951855f))));
}

float cosf(float x) {
    // cos(x) = sin(x + PI/2)
    return sinf(x + (PI * 0.5f));
}

float tanf(float x) {
    // Fast polynomial quotient 
    return sinf(x) / cosf(x);
}

float atanf(float x) {
    // Range reduction if |x| > 1 using identity: atan(x) = sign(x)*PI/2 - atan(1/x)
    if (fabsf(x) > 1.0f) {
        return (x > 0 ? (PI / 2.0f) : (-PI / 2.0f)) - atanf(1.0f / x);
    }
    
    // Maclaurin series for |x| <= 1
    float sum = x;
    float term = x;
    float x2 = x * x;
    for (int i = 3; i < 25; i += 2) {
        term *= -x2;
        sum += term / i;
    }
    return sum;
}

float atan2f(float y, float x) {
    if (x > 0.0f) return atanf(y / x);
    if (x < 0.0f && y >= 0.0f) return atanf(y / x) + PI;
    if (x < 0.0f && y < 0.0f) return atanf(y / x) - PI;
    if (x == 0.0f && y > 0.0f) return PI / 2.0f;
    if (x == 0.0f && y < 0.0f) return -PI / 2.0f;
    return 0.0f; // x == 0, y == 0 (undefined behavior handling)
}

float asinf(float x) {
    if (x < -1.0f || x > 1.0f) return (0.0f / 0.0f); // Domain error
    if (x == 1.0f) return PI / 2.0f;
    if (x == -1.0f) return -PI / 2.0f;
    
    // Identity: asin(x) = atan(x / sqrt(1 - x^2))
    return atanf(x / sqrtf(1.0f - x * x));
}

float acosf(float x) {
    if (x < -1.0f || x > 1.0f) return (0.0f / 0.0f); // Domain error
    // Identity: acos(x) = PI / 2 - asin(x)
    return (PI / 2.0f) - asinf(x);
}
