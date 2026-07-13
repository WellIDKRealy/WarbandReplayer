#include "stdio.h"

// Define dummy file pointers to satisfy macro invocations
static FILE stdout_stub;
static FILE stderr_stub;
FILE* stdout = &stdout_stub;
FILE* stderr = &stderr_stub;

// Declare the external JavaScript handler provided by the browser environment
__attribute__((import_module("env"), import_name("js_print_string")))
extern void js_print_string(const char* str);

int fflush(FILE* stream) {
    (void)stream;
    return 0; // No-op for custom JS-piped stream
}

// Internal Helper: Convert integer values to string representation
static int int_to_str(char* buf, size_t size, long long val, int radix, int is_signed) {
    char tmp[64];
    int i = 0;
    unsigned long long uval = val;
    int negative = 0;

    if (is_signed && val < 0) {
        negative = 1;
        uval = -val;
    }

    if (uval == 0) {
        tmp[i++] = '0';
    } else {
        while (uval > 0) {
            int rem = uval % radix;
            tmp[i++] = (rem < 10) ? (rem + '0') : (rem - 10 + 'a');
            uval /= radix;
        }
    }

    if (negative) tmp[i++] = '-';

    int written = 0;
    for (int j = i - 1; j >= 0; j--) {
        if ((size_t)written < size - 1) {
            buf[written++] = tmp[j];
        }
    }
    buf[written] = '\0';
    return written;
}

// Internal Helper: Convert float/double values to string representation
static int float_to_str(char* buf, size_t size, double val, int precision) {
    if (precision < 0) precision = 6;
    int written = 0;

    if (val < 0) {
        if ((size_t)written < size - 1) buf[written++] = '-';
        val = -val;
    }

    long long ipart = (long long)val;
    double fpart = val - (double)ipart;

    char int_buf[64];
    int int_len = int_to_str(int_buf, sizeof(int_buf), ipart, 10, 0);
    for (int i = 0; i < int_len; i++) {
        if ((size_t)written < size - 1) buf[written++] = int_buf[i];
    }

    if (precision > 0) {
        if ((size_t)written < size - 1) buf[written++] = '.';
        for (int i = 0; i < precision; i++) {
            fpart *= 10.0;
            int digit = (int)fpart;
            if ((size_t)written < size - 1) buf[written++] = digit + '0';
            fpart -= digit;
        }
    }
    buf[written] = '\0';
    return written;
}

// Basic structural vsnprintf with field width support
int vsnprintf(char* str, size_t size, const char* format, __builtin_va_list ap) {
    size_t i = 0, out_idx = 0;
    
    while (format[i] != '\0') {
        if (format[i] == '%') {
            i++;
            int left_align = 0, pad_char = ' ', width = 0, precision = -1;
            
            if (format[i] == '-') { left_align = 1; i++; }
            if (format[i] == '0') { pad_char = '0'; i++; }
            
            while (format[i] >= '0' && format[i] <= '9') {
                width = width * 10 + (format[i] - '0');
                i++;
            }
            if (format[i] == '.') {
                i++; precision = 0;
                while (format[i] >= '0' && format[i] <= '9') {
                    precision = precision * 10 + (format[i] - '0');
                    i++;
                }
            }
            if (format[i] == 'l') { i++; if (format[i] == 'l') i++; }
            
            char spec = format[i++];
            char tmp_buf[512];
            int tmp_len = 0;
            
            if (spec == 'c') {
                tmp_buf[0] = (char)__builtin_va_arg(ap, int);
                tmp_buf[1] = '\0';
                tmp_len = 1;
            } else if (spec == 's') {
                char* s = __builtin_va_arg(ap, char*);
                if (!s) s = "(null)";
                while (s[tmp_len] != '\0' && tmp_len < (int)sizeof(tmp_buf) - 1) {
                    tmp_buf[tmp_len] = s[tmp_len];
                    tmp_len++;
                }
                tmp_buf[tmp_len] = '\0';
            } else if (spec == 'd' || spec == 'i') {
                tmp_len = int_to_str(tmp_buf, sizeof(tmp_buf), __builtin_va_arg(ap, int), 10, 1);
            } else if (spec == 'u') {
                tmp_len = int_to_str(tmp_buf, sizeof(tmp_buf), __builtin_va_arg(ap, unsigned int), 10, 0);
            } else if (spec == 'f') {
                tmp_len = float_to_str(tmp_buf, sizeof(tmp_buf), __builtin_va_arg(ap, double), precision);
            } else {
                tmp_buf[0] = spec; tmp_buf[1] = '\0'; tmp_len = 1;
            }
            
            int padding = width - tmp_len;
            if (padding > 0 && !left_align) {
                for (int p = 0; p < padding; p++) if (out_idx < size - 1) str[out_idx++] = pad_char;
            }
            for (int t = 0; t < tmp_len; t++) if (out_idx < size - 1) str[out_idx++] = tmp_buf[t];
            if (padding > 0 && left_align) {
                for (int p = 0; p < padding; p++) if (out_idx < size - 1) str[out_idx++] = ' ';
            }
        } else {
            if (out_idx < size - 1) str[out_idx++] = format[i];
            i++;
        }
    }
    if (size > 0) str[out_idx] = '\0';
    return out_idx;
}

int snprintf(char* str, size_t size, const char* format, ...) {
    __builtin_va_list ap;
    __builtin_va_start(ap, format);
    int len = vsnprintf(str, size, format, ap);
    __builtin_va_end(ap);
    return len;
}

int printf(const char* format, ...) {
    char buf[2048];
    __builtin_va_list ap;
    __builtin_va_start(ap, format);
    int len = vsnprintf(buf, sizeof(buf), format, ap);
    __builtin_va_end(ap);
    js_print_string(buf);
    return len;
}

int fprintf(FILE* stream, const char* format, ...) {
    (void)stream;
    char buf[2048];
    __builtin_va_list ap;
    __builtin_va_start(ap, format);
    int len = vsnprintf(buf, sizeof(buf), format, ap);
    __builtin_va_end(ap);
    js_print_string(buf);
    return len;
}

int isatty(int fd) {
    (void)fd;
    return 0;
}

FILE *fopen(const char *filename, const char *mode) {
    (void)filename; (void)mode;
    return NULL; // File output not supported in raw browser sandbox
}

int fclose(FILE *stream) {
    (void)stream;
    return 0;
}

__attribute__((import_module("env"), import_name("emscripten_performance_now")))
extern double emscripten_performance_now(void);
