#include "stdlib.h"
#include "string.h"

/* malloc/free/realloc/calloc now live in heap.c (a real boundary-tag
 * free-list heap) - this file kept the old 256KB-bump/leak-everything
 * allocator, which was unusable for any real SQLite workload. */

void exit(int status) {
    (void)status;
    while(1); // Trap WebAssembly thread execution
}

void abort(void) {
    while(1); // Trap WebAssembly thread execution - same convention as exit()
}

double atof(const char *str) {
    if (!str) return 0.0;
    
    while (*str == ' ' || *str == '\t') str++; // Skip whitespace
    
    double sign = 1.0;
    if (*str == '-') { sign = -1.0; str++; }
    else if (*str == '+') { str++; }
    
    double res = 0.0;
    double factor = 1.0;
    int check_decimal = 0;
    
    while (*str) {
        if (*str == '.') {
            check_decimal = 1;
            str++;
            continue;
        }
        if (*str >= '0' && *str <= '9') {
            if (check_decimal) {
                factor *= 0.1;
                res = res + (*str - '0') * factor;
            } else {
                res = res * 10.0 + (*str - '0');
            }
        } else {
            break;
        }
        str++;
    }
    return sign * res;
}
