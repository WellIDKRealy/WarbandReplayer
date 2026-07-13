#include "stdlib.h"
#include "string.h"

#define ARENA_SIZE (256 * 1024) // 256KB static footprint for benchmark allocations
static unsigned char arena[ARENA_SIZE];
static size_t arena_idx = 0;

void *malloc(size_t size) {
    // 8-byte memory boundary alignment
    size = (size + 7) & ~7;
    if (arena_idx + sizeof(size_t) + size > ARENA_SIZE) return NULL;
    
    // Store size inline behind the pointer to handle realloc requests later
    size_t *header = (size_t *)&arena[arena_idx];
    *header = size;
    
    void *ptr = (void *)(header + 1);
    arena_idx += sizeof(size_t) + size;
    return ptr;
}

void free(void *ptr) {
    (void)ptr; // No-op: Benchmarks live for the application duration
}

void *realloc(void *ptr, size_t size) {
    if (!ptr) return malloc(size);
    
    size_t *header = (size_t *)ptr - 1;
    size_t old_size = *header;
    
    if (size <= old_size) return ptr; 
    
    void *new_ptr = malloc(size);
    if (new_ptr) {
        memcpy(new_ptr, ptr, old_size);
    }
    return new_ptr;
}

void exit(int status) {
    (void)status;
    while(1); // Trap WebAssembly thread execution
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
