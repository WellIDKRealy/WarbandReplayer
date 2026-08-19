# Vendored LZMA SDK (public domain)

These files are a subset of the 7-Zip LZMA SDK, written and placed in the
public domain by Igor Pavlov (SHA-256 is based on public domain code from
Wei Dai's Crypto++ library - see `Sha256.c`'s own header). Every file here
carries its own `Public domain` header comment; verified individually before
vendoring (2026-08-17), not just at the SDK-package level.

- **Source**: `C/` directory of the LZMA SDK, mirrored at
  https://github.com/jljusten/LZMA-SDK (a plain-source git mirror of the
  official 7-zip.org LZMA SDK releases - used here only because the official
  distribution is a `.7z` archive and this environment has no 7z extractor;
  the mirror's `DOC/lzma-sdk.txt` license text is byte-identical to the
  official SDK's).
- **Commit vendored from**: `781863cdf592da3e97420f50de5dac056ad352a5`
  (SDK version 18.05, per `DOC/lzma-history.txt`).
- **Subset taken**: one-shot in-memory LZMA2/xz *encoding and decoding*,
  single-threaded (`-D_7ZIP_ST`, see `Makefile`'s `COMPRESS-FLAGS`) - no 7z
  archive format, no BCJ/branch/delta filters actually applied (Bra.c/
  Delta.c are vendored only because XzDec.c references their symbols
  unconditionally - see the `BraState_SetFromMethod` note below; this build
  never encodes or decodes a stream that uses them), no multi-threaded
  match finder or decoder. Deliberately excluded:
  `Threads.c`/`MtCoder.c` (multi-threaded match finder - `_7ZIP_ST` compiles
  out every call site in `Lzma2Enc.c`/`XzEnc.c`, so neither file, nor
  `LzFindMt.c`, is even referenced), `Alloc.c` (its `ISzAlloc` is replaced by
  a small shim in `compress_worker.c` mapping onto goyslopless-c's
  malloc/free), `XzDec.c`/decoders (encode-only). One small stub -
  `BraState_SetFromMethod()` in `compress_worker.c` - satisfies a link-time
  reference `XzEnc.c` makes into the (excluded) decoder's BCJ filter state
  machine; it's never actually called since this build never configures a
  filter (`CXzFilterProps.id` stays 0, see `XzFilterProps_Init`).
