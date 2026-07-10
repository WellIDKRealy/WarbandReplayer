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
    if (isnan(x) || isinf(x)) return x;
    
    int xi = (int)x;
    float fxi = (float)xi;
    
    if (x < fxi) {
        return fxi - 1.0f;
    }
    return fxi;
}

float fminf(float a, float b) {
    if (isnan(a)) return b;
    if (isnan(b)) return a;
    return (a < b) ? a : b;
}

float fmodf(float x, float y) {
    if (isnan(x) || isnan(y) || isinf(x) || y == 0.0f) {
        return (x * y) / (x * y); // Generates NaN safely
    }
    if (isinf(y)) return x;

    float quotient = floorf(x / y);
    return x - quotient * y;
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
    if (x < 0.0f) return (0.0f / 0.0f); // Return NaN for negative inputs
    if (x == 0.0f || isinf(x) || isnan(x)) return x;

    // Initial rough estimate using bit shift (Fast Inverse Square Root approach style)
    float_bits u;
    u.f = x;
    u.i = (u.i >> 1) + 0x1FBC0000; 
    float res = u.f;

    // 3 iterations of Newton-Raphson for 32-bit float precision
    res = 0.5f * (res + x / res);
    res = 0.5f * (res + x / res);
    res = 0.5f * (res + x / res);
    
    return res;
}

// Internal helper: Natural logarithm approximation for powf
static float logf_impl(float x) {
    if (x <= 0.0f) return (0.0f / 0.0f);
    // Taylor series centered around 1: ln(x) = 2 * sum( ((x-1)/(x+1))^n / n )
    float y = (x - 1.0f) / (x + 1.0f);
    float y2 = y * y;
    float sum = 0.0f;
    float term = y;
    for (int i = 1; i < 20; i += 2) {
        sum += term / i;
        term *= y2;
    }
    return 2.0f * sum;
}

// Internal helper: e^x approximation
static float expf_impl(float x) {
    float sum = 1.0f;
    float term = 1.0f;
    for (int i = 1; i < 15; i++) {
        term *= x / i;
        sum += term;
    }
    return sum;
}

float powf(float base, float exponent) {
    if (base == 0.0f && exponent > 0.0f) return 0.0f;
    if (exponent == 0.0f) return 1.0f;
    if (base < 0.0f) {
        // Only integer exponents are valid for negative bases
        float iptr;
        if (modff(exponent, &iptr) == 0.0f) {
            float abs_res = expf_impl(exponent * logf_impl(-base));
            return ((int)exponent % 2 == 0) ? abs_res : -abs_res;
        }
        return (0.0f / 0.0f); // NaN
    }
    return expf_impl(exponent * logf_impl(base));
}

#define PI 3.14159265358979323846f

float sinf(float x) {
    // Bring x into range [-PI, PI]
    x = fmodf(x, 2.0f * PI);
    if (x > PI) x -= 2.0f * PI;
    if (x < -PI) x += 2.0f * PI;

    float sum = x;
    float term = x;
    float x2 = x * x;
    
    // Maclaurin Expansion
    for (int i = 3; i < 16; i += 2) {
        term *= -x2 / (i * (i - 1));
        sum += term;
    }
    return sum;
}

float cosf(float x) {
    x = fmodf(x, 2.0f * PI);
    if (x > PI) x -= 2.0f * PI;
    if (x < -PI) x += 2.0f * PI;

    float sum = 1.0f;
    float term = 1.0f;
    float x2 = x * x;

    for (int i = 2; i < 16; i += 2) {
        term *= -x2 / (i * (i - 1));
        sum += term;
    }
    return sum;
}

float tanf(float x) {
    float c = cosf(x);
    if (c == 0.0f) return (0.0f / 0.0f); // Division by zero NaN
    return sinf(x) / c;
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
