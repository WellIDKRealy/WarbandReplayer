/*
 * Cross-origin isolation shim for static hosts (GitHub Pages, etc.) that
 * can't set custom response headers. `SharedArrayBuffer` / shared
 * `WebAssembly.Memory` / `Atomics.wait` in Workers all require
 * `window.crossOriginIsolated === true`, which the browser only grants
 * when the *document's own* response carries:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 * A Service Worker can inject those headers into every response it
 * intercepts - including the navigation request for the page itself -
 * which is enough to satisfy the browser without any server config.
 *
 * Single file, dual role (same trick real-world COI shims use): loaded
 * as a normal <script> in the page, it registers itself as its own
 * Service Worker; the browser then also executes this exact file a
 * second time in the Service Worker context, where the `self.window`
 * check below routes it into the fetch-intercepting half instead.
 *
 * Usage: <script src="coi-shim.js"></script> as the FIRST thing in
 * <head>, before any script that touches SharedArrayBuffer/shared
 * WebAssembly.Memory.
 */
(() => {
  const isServiceWorker = typeof window === "undefined";

  if (isServiceWorker) {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("fetch", (event) => {
      const request = event.request;
      if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.status === 0) return response; // opaque cross-origin response, can't touch headers
            const headers = new Headers(response.headers);
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          })
          .catch((err) => new Response("coi-shim fetch failed: " + err.message, { status: 500 }))
      );
    });
    return;
  }

  // Already isolated (real server headers, or this shim already active
  // from a previous load) - nothing to do.
  if (window.crossOriginIsolated) return;

  // Service workers need a secure context (https, or localhost).
  if (!window.isSecureContext) {
    console.warn("[coi-shim] not a secure context - crossOriginIsolated unavailable, shared memory features will fail.");
    return;
  }

  navigator.serviceWorker
    .register(document.currentScript.src, { scope: "./" })
    .then((registration) => {
      registration.addEventListener("updatefound", () => {});
      // The current navigation wasn't intercepted by this worker (it
      // didn't exist yet) - reload once it's controlling the page so
      // crossOriginIsolated actually flips on for this load.
      if (registration.active && !navigator.serviceWorker.controller) {
        window.location.reload();
      }
    })
    .catch((err) => {
      console.warn("[coi-shim] service worker registration failed, shared memory features will be unavailable:", err);
    });

  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
})();
