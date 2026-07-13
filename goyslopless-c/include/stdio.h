#ifndef _STDIO_H
#define _STDIO_H

#include <stddef.h>

struct FILE {
  int handle;
};

typedef struct FILE FILE;

extern FILE* stdout;
extern FILE* stderr;

int printf(const char* format, ...);
int fprintf(FILE* stream, const char* format, ...);
int sprintf(char* str, const char* format, ...);
int snprintf(char* str, size_t size, const char* format, ...);
int vsnprintf(char* str, size_t size, const char* format, __builtin_va_list ap);
int fflush(FILE* stream);

FILE *fopen(const char *filename, const char *mode);
int fclose(FILE *stream);

#endif
