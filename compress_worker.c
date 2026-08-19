/*
 * Standalone xz/LZMA2 compressor - a separate wasm module (compress.wasm)
 * from replay_worker.wasm on purpose (see lzma-sdk/NOTICE.md and the
 * project plan): keeps the hot-path binary lean, and lets compression run
 * on the simpler, already-elastic non-threaded goyslopless-c heap instead
 * of needing any of replay_worker.wasm's fixed-slab/threading machinery.
 *
 * One-shot, buffer-to-buffer: JS streams the uncompressed tar bytes in via
 * compress_feed_chunk() (same bounded-chunk idiom as replay_feed_chunk()),
 * then compress_finish() runs the real LZMA SDK's Xz_Encode() over the
 * whole thing in one call and leaves the compressed bytes at
 * compress_get_output_ptr()/compress_get_output_len().
 */
#include "lzma-sdk/7zTypes.h"
#include "lzma-sdk/Alloc.h"
#include "lzma-sdk/7zCrc.h"
#include "lzma-sdk/XzCrc64.h"
#include "lzma-sdk/Xz.h"
#include "lzma-sdk/XzEnc.h"
#include <stdlib.h>
#include <string.h>

/* Xz.h forward-declares CXzUnpacker's decoder internals via LzmaDec/Lzma2Dec
 * types, so this needs to come after Xz.h despite decompress_finish() being
 * the only thing that actually calls into it. */
#include "lzma-sdk/Lzma2Dec.h"

#define CHUNK_SIZE (1024 * 1024)

static char g_last_error[256];
static void set_error(const char *msg) {
    int i = 0;
    if (msg) while (msg[i] && i < 255) { g_last_error[i] = msg[i]; i++; }
    g_last_error[i] = 0;
}
const char *compress_get_last_error(void) { return g_last_error; }

/* ---- input: accumulated via bounded chunks into one growable buffer ---- */
static unsigned char g_chunk[CHUNK_SIZE];
static unsigned char *g_input = 0;
static size_t g_input_len = 0, g_input_cap = 0, g_input_pos = 0;

static int g_crc_tables_ready = 0;

void compress_begin(void) {
    /* g_CrcUpdate/g_CrcUpdateT4/g_CrcUpdateT8 (7zCrc.c) and the CRC64 table
     * (XzCrc64.c) are plain global function-pointer/table statics with no
     * constructor - the SDK requires callers to populate them once before
     * any CRC function runs (see 7zCrc.h's own comment), or every call
     * through the still-NULL g_CrcUpdate pointer traps. Idempotent, so it's
     * safe (and cheap) to just always do it here rather than tracking
     * whether some other caller already did. */
    if (!g_crc_tables_ready) {
        CrcGenerateTable();
        Crc64GenerateTable();
        g_crc_tables_ready = 1;
    }
    free(g_input);
    g_input = 0; g_input_len = 0; g_input_cap = 0; g_input_pos = 0;
    set_error("");
}
unsigned char *compress_get_input_chunk_ptr(void) { return g_chunk; }
int compress_feed_chunk(int len) {
    if (g_input_len + (size_t)len > g_input_cap) {
        size_t newcap = g_input_cap ? g_input_cap : 65536;
        while (newcap < g_input_len + (size_t)len) newcap *= 2;
        unsigned char *nb = (unsigned char *)realloc(g_input, newcap);
        if (!nb) { set_error("out of memory growing compressor input buffer"); return -1; }
        g_input = nb; g_input_cap = newcap;
    }
    memcpy(g_input + g_input_len, g_chunk, (size_t)len);
    g_input_len += (size_t)len;
    return 0;
}

/* ---- output: grown on demand by the encoder's Write callback ---------- */
static unsigned char *g_output = 0;
static size_t g_output_len = 0, g_output_cap = 0;
static int g_write_call_count = 0;
static size_t g_write_bytes_total = 0;
int compress_debug_write_call_count(void) { return g_write_call_count; }
double compress_debug_write_bytes_total(void) { return (double)g_write_bytes_total; }

static size_t MyWrite(const ISeqOutStream *pp, const void *data, size_t size) {
    (void)pp;
    g_write_call_count++;
    g_write_bytes_total += size;
    if (g_output_len + size > g_output_cap) {
        size_t newcap = g_output_cap ? g_output_cap : 65536;
        while (newcap < g_output_len + size) newcap *= 2;
        unsigned char *nb = (unsigned char *)realloc(g_output, newcap);
        if (!nb) return 0; /* SDK treats a short write as a stream error */
        g_output = nb; g_output_cap = newcap;
    }
    memcpy(g_output + g_output_len, data, size);
    g_output_len += size;
    return size;
}
static ISeqOutStream g_out_vt = { MyWrite };

static SRes MyRead(const ISeqInStream *pp, void *buf, size_t *size) {
    (void)pp;
    size_t remaining = g_input_len - g_input_pos;
    size_t n = (*size < remaining) ? *size : remaining;
    if (n > 0) memcpy(buf, g_input + g_input_pos, n);
    g_input_pos += n;
    *size = n;
    return SZ_OK;
}
static ISeqInStream g_in_vt = { MyRead };

/* ---- ISzAlloc shim onto goyslopless-c's malloc/free --------------------
 * g_Alloc/g_BigAlloc are not our naming choice - Alloc.h declares them
 * `extern`, and the SDK's own Xz_Encode() (XzEnc.c) references them by
 * these exact names. We don't vendor Alloc.c (its BigAlloc() is a
 * VirtualAlloc/mmap OS call, meaningless in this freestanding wasm32
 * build), so these definitions - both just goyslopless-c malloc/free,
 * "big" vs "small" is not a distinction that matters here - are what
 * actually satisfies that link-time reference. */
static void *SzAlloc(ISzAllocPtr pp, size_t size) { (void)pp; return malloc(size); }
static void SzFree(ISzAllocPtr pp, void *addr) { (void)pp; free(addr); }
const ISzAlloc g_Alloc = { SzAlloc, SzFree };
const ISzAlloc g_BigAlloc = { SzAlloc, SzFree };

/* BraState_SetFromMethod() - the BCJ filter state-machine constructor
 * XzEnc.c references at link time even though this build never configures
 * a filter (CXzFilterProps.id stays 0, from XzFilterProps_Init) - is now
 * provided by the real XzDec.c (vendored for decompression), not a stub
 * here. See lzma-sdk/NOTICE.md. */

/* dictSizeMiB <= 0 selects the default (moderate, 24MiB - see the plan's
 * "extreme compression vs 128MB" tradeoff note: a single battle's export is
 * bounded/tens-of-MB, not 20GB, so a moderate dictionary already captures
 * the same redundancy a much bigger one would; callers that want the
 * higher "extreme" tier pass a larger explicit value). */
int compress_finish(int dictSizeMiB) {
    g_input_pos = 0;
    free(g_output); g_output = 0; g_output_len = 0; g_output_cap = 0;
    g_write_call_count = 0; g_write_bytes_total = 0;

    CXzProps props;
    XzProps_Init(&props);
    props.lzma2Props.lzmaProps.dictSize = (UInt32)(dictSizeMiB > 0 ? dictSizeMiB : 24) * 1024u * 1024u;

    SRes res = Xz_Encode(&g_out_vt, &g_in_vt, &props, 0);
    if (res != SZ_OK) { set_error("Xz_Encode failed"); return -1; }
    return 0;
}

/* ---- decompression: shares compress_begin/compress_get_input_chunk_ptr/
 * compress_feed_chunk for input (same growable g_input buffer, same CRC
 * table init - decoding verifies checksums too) and g_output/g_output_len
 * for the result, so JS drives both directions through the same handful of
 * exports, just calling compress_finish() or decompress_finish() at the
 * end depending on direction. Uses the streaming XzUnpacker_Code() loop
 * (not XzUnpacker_CodeFull(), which needs the exact uncompressed size
 * known upfront) since the uncompressed tar size isn't known before
 * decoding it - same growable-output-buffer pattern as MyWrite above. */
int decompress_finish(void) {
    g_output_len = 0; /* keep g_output_cap/allocation - reused across calls like MyWrite's buffer */
    g_input_pos = 0;

    CXzUnpacker xz;
    XzUnpacker_Construct(&xz, &g_Alloc);
    XzUnpacker_Init(&xz);

    int rc = 0;
    for (;;) {
        if (g_output_cap - g_output_len < 65536) {
            size_t newcap = g_output_cap ? g_output_cap * 2 : 65536;
            unsigned char *nb = (unsigned char *)realloc(g_output, newcap);
            if (!nb) { set_error("out of memory growing decompressor output buffer"); rc = -1; break; }
            g_output = nb; g_output_cap = newcap;
        }
        SizeT destLen = g_output_cap - g_output_len;
        SizeT srcLen = g_input_len - g_input_pos;
        int srcFinished = (g_input_pos + srcLen >= g_input_len) ? 1 : 0;
        ECoderStatus status;
        SRes res = XzUnpacker_Code(&xz, g_output + g_output_len, &destLen,
                                    g_input + g_input_pos, &srcLen,
                                    srcFinished, CODER_FINISH_ANY, &status);
        g_output_len += destLen;
        g_input_pos += srcLen;
        if (res != SZ_OK) { set_error("XzUnpacker_Code failed (corrupt stream or bad checksum?)"); rc = -2; break; }
        if (status == CODER_STATUS_NEEDS_MORE_INPUT) {
            if (XzUnpacker_IsStreamWasFinished(&xz)) break; /* done */
            set_error("xz stream ended unexpectedly (truncated input?)"); rc = -3; break;
        }
        /* CODER_STATUS_NOT_FINISHED: loop again - either destLen was fully
         * used (need more output room, handled by the growth check above)
         * or there's more to decode from the remaining input. */
    }

    XzUnpacker_Free(&xz);
    return rc;
}

unsigned char *compress_get_output_ptr(void) { return g_output; }
double compress_get_output_len(void) { return (double)g_output_len; }
/* debug: read a byte through the SAME C pointer JS is reading via a raw
 * memory view, to tell apart "the bytes are genuinely wrong" from "JS is
 * looking at the wrong place". */
int compress_debug_output_byte(int i) {
    if (!g_output || i < 0 || (size_t)i >= g_output_len) return -999;
    return (int)g_output[i];
}
