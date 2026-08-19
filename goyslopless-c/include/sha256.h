#ifndef _SHA256_H
#define _SHA256_H

#include "stddef.h"
#include "stdint.h"

/* Incremental SHA-256 (FIPS 180-4). Needed because the source replay file
 * can be up to 20GB and streams into replay_feed_chunk() one bounded
 * LOAD_CHUNK_SIZE piece at a time - crypto.subtle.digest() on the JS side
 * has no streaming/update API, so the hash has to be accumulated in C as
 * each chunk arrives, not computed after the fact over the whole file. */
typedef struct {
    uint8_t data[64];
    uint32_t datalen;
    uint64_t bitlen;
    uint32_t state[8];
} sha256_ctx;

void sha256_init(sha256_ctx *ctx);
void sha256_update(sha256_ctx *ctx, const uint8_t *data, size_t len);
void sha256_final(sha256_ctx *ctx, uint8_t hash[32]);

/* hex[64] chars + NUL, matches battle.db/manifest.json's textual sha256 fields */
void sha256_to_hex(const uint8_t hash[32], char hex[65]);

#endif
