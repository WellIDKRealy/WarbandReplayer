#include "string.h"

size_t strlen(const char *s) {
    size_t len = 0;
    while (s[len] != '\0') len++;
    return len;
}

int strcmp(const char *s1, const char *s2) {
    while (*s1 && (*s1 == *s2)) {
        s1++;
        s2++;
    }
    return *(unsigned char *)s1 - *(unsigned char *)s2;
}

int strncmp(const char *s1, const char *s2, size_t n) {
    while (n && *s1 && (*s1 == *s2)) {
        s1++;
        s2++;
        n--;
    }
    if (n == 0) return 0;
    return *(unsigned char *)s1 - *(unsigned char *)s2;
}

void *memset(void *s, int c, size_t n) {
    unsigned char *p = s;
    while (n--) {
        *p++ = (unsigned char)c;
    }
    return s;
}

void *memcpy(void *dest, const void *src, size_t n) {
    unsigned char *d = dest;
    const unsigned char *s = src;
    while (n--) {
        *d++ = *s++;
    }
    return dest;
}

/* Unlike memcpy, the source and destination regions are allowed to
 * overlap, so we must copy backwards whenever dest sits after src
 * inside the overlapping range. */
void *memmove(void *dest, const void *src, size_t n) {
    unsigned char *d = dest;
    const unsigned char *s = src;
    if (d == s || n == 0) return dest;
    if (d < s) {
        while (n--) *d++ = *s++;
    } else {
        d += n;
        s += n;
        while (n--) *--d = *--s;
    }
    return dest;
}

int memcmp(const void *s1, const void *s2, size_t n) {
    const unsigned char *p1 = s1, *p2 = s2;
    while (n--) {
        if (*p1 != *p2) return *p1 - *p2;
        p1++; p2++;
    }
    return 0;
}

void *memchr(const void *s, int c, size_t n) {
    const unsigned char *p = s;
    while (n--) {
        if (*p == (unsigned char)c) return (void *)p;
        p++;
    }
    return NULL;
}

char *strchr(const char *s, int c) {
    while (*s) {
        if (*s == (char)c) return (char *)s;
        s++;
    }
    return (c == '\0') ? (char *)s : NULL;
}

char *strrchr(const char *s, int c) {
    const char *last = (c == '\0') ? s : NULL;
    while (*s) {
        if (*s == (char)c) last = s;
        s++;
    }
    /* Handles the NUL-terminator search case (c == 0) too, since `last`
     * was seeded above and never overwritten by the loop in that case. */
    return (char *)last;
}

size_t strcspn(const char *s, const char *reject) {
    size_t count = 0;
    while (s[count]) {
        for (const char *r = reject; *r; r++) {
            if (s[count] == *r) return count;
        }
        count++;
    }
    return count;
}

size_t strspn(const char *s, const char *accept) {
    size_t count = 0;
    while (s[count]) {
        const char *a = accept;
        while (*a && *a != s[count]) a++;
        if (!*a) break;
        count++;
    }
    return count;
}

char *strcpy(char *dest, const char *src) {
    char *d = dest;
    while ((*d++ = *src++));
    return dest;
}

char *strstr(const char *haystack, const char *needle) {
    if (!*needle) return (char *)haystack;
    for (; *haystack; haystack++) {
        if (*haystack == *needle) {
            const char *h = haystack;
            const char *n = needle;
            while (*h && *n && *h == *n) {
                h++;
                n++;
            }
            if (!*n) return (char *)haystack;
        }
    }
    return NULL;
}
