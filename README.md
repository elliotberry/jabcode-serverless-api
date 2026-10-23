# jabcode-worker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) that encodes and decodes
[JAB Code](https://jabcode.org/) (Just Another Barcode) symbols — the colour 2D barcode
standard (ISO/IEC 23634) — using [libjabcode](https://github.com/jabcode/jabcode) compiled to
WebAssembly.

- `GET /encode?text=...` returns the JABCode as a **PNG image**.
- `POST /decode` takes raw RGBA pixels and returns the **decoded text**.
- No external services, no native dependencies, no runtime `npm` dependencies: the Worker is
  the wasm module, a thin Emscripten loader, a small JS wrapper, and a hand-rolled PNG writer.

## Table of contents

- [Quick start](#quick-start)
- [API](#api)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [The WebAssembly module](#the-webassembly-module)
- [Cloudflare-specific changes to the Emscripten loader](#cloudflare-specific-changes-to-the-emscripten-loader)
- [JS wrapper API (`jabcode.js`)](#js-wrapper-api-jabcodejs)
- [Deployment](#deployment)
- [Performance and limits](#performance-and-limits)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

## Quick start

Requirements: Node.js (a recent LTS) and a Cloudflare account (only needed to deploy).

```bash
npm install
npx wrangler dev          # serves on http://localhost:8787
```

Then, in another terminal:

```bash
# Save a JABCode as a PNG
curl -o hello.png "http://localhost:8787/encode?text=hello"

# Round trip: encode to raw RGBA (JSON), feed it straight back into /decode
curl -s "http://localhost:8787/encode?text=hello&format=json" \
  | curl -s -X POST http://localhost:8787/decode --data-binary @-
# {"text":"hello"}
```

## API

### `GET /encode`

Encodes text as a JABCode symbol.

| Query parameter | Required | Description                                                         |
| --------------- | -------- | ------------------------------------------------------------------- |
| `text`          | yes      | The string to encode (UTF-8).                                       |
| `format`        | no       | Omit for a PNG. Use `json` for raw RGBA pixels as base64 JSON.      |

The symbol is always generated with fixed settings (see [Configuration](#configuration)):
8 colours, 12 px modules, ECC level 3.

**Default response** — `200 OK`

```
Content-Type: image/png
Cache-Control: public, max-age=86400
```

The body is an 8-bit RGBA, non-interlaced PNG. Output is deterministic for a given `text`, which
is why it is marked cacheable for a day.

**`format=json` response** — `200 OK`

```json
{ "width": 252, "height": 252, "rgba": "<base64 of width*height*4 bytes>" }
```

`rgba` is the raw pixel buffer (row-major, 4 bytes per pixel: R, G, B, A). This is exactly the
shape `POST /decode` accepts.

**Errors**

| Status | Body                              | Cause                                                            |
| ------ | --------------------------------- | ---------------------------------------------------------------- |
| 400    | `{"error":"missing ?text="}`      | `text` absent or empty.                                          |
| 422    | `{"error":"encoding failed ..."}` | libjabcode could not encode (e.g. data too large for one symbol). |
| 500    | `{"error":"internal error"}`      | Unexpected failure; details are logged.                          |

### `POST /decode`

Decodes a JABCode from raw pixels.

Request body (JSON):

```json
{ "width": 252, "height": 252, "rgba": "<base64 RGBA>" }
```

- `rgba` must decode to exactly `width * height * 4` bytes.
- The image must contain the symbol with a reasonable quiet zone; photographs/skewed captures
  are subject to libjabcode's detector (see [Known limitations](#known-limitations)).

Response — `200 OK`

```json
{ "text": "hello" }
```

**Errors**

| Status | Body example                                                         | Cause                                            |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------ |
| 422    | `{"error":"no decodable JABCode found (not detectable)"}`            | No finder patterns found.                        |
| 422    | `{"error":"no decodable JABCode found (detected but not decodable)"}`| Symbol located but could not be decoded.         |
| 422    | `{"error":"data length must equal width * height * 4 (RGBA)"}`       | Pixel buffer does not match the dimensions.      |
| 500    | `{"error":"internal error"}`                                         | Unexpected failure, including malformed JSON.    |

> Note: only *raw RGBA* is accepted. PNG input is not decoded by the Worker.

### Other routes

Anything else returns `404 Not found`.

### Example: decoding a PNG by converting it client-side

Because `/decode` needs raw pixels, convert images to RGBA first. For example with Node and
[`sharp`](https://sharp.pixelplumbing.com/) (not a dependency of this repo):

```js
import sharp from "sharp";

const { data, info } = await sharp("hello.png")
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const res = await fetch("http://localhost:8787/decode", {
  method: "POST",
  body: JSON.stringify({
    width: info.width,
    height: info.height,
    rgba: data.toString("base64"),
  }),
});
console.log(await res.json()); // { text: "hello" }
```

## How it works

```
                     ┌────────────────────────── Cloudflare Worker isolate ──────────────────────────┐
 GET /encode ───────▶│ index.js ──▶ jabcode.js ──▶ jabcode.mjs (Emscripten glue) ──▶ jabcode.wasm     │
                     │    │             (wrapper:        (heap views, imports,         (libjabcode +   │
                     │    │              malloc/copy)     memory growth)                small C shim)  │
                     │    └──▶ encodePng(): filter byte + CompressionStream("deflate") + CRC32 chunks │
 ◀── image/png ──────│                                                                                │
                     └────────────────────────────────────────────────────────────────────────────────┘
```

**Startup (once per isolate).** `index.js` imports `jabcode.wasm`. Wrangler treats `.wasm`
imports as a precompiled `WebAssembly.Module`, since Workers do not allow compiling wasm from
bytes at runtime. The module is instantiated with top-level `await createJabcode({ instantiateWasm })`
so that every request reuses one instance instead of paying instantiation cost each time.

**Encode.** The string is UTF-8 encoded and copied into wasm memory with `_malloc`. The C shim
function `jab_wasm_encode(ptr, len, colors, moduleSize, ecc)` renders the symbol into an
internal bitmap. The wrapper reads the width, height, and pixel pointer, **copies** the pixels out
of the wasm heap (so they survive heap growth), and calls `jab_wasm_free()` to release the bitmap.

**PNG output.** `encodePng()` in `index.js` writes the PNG itself:

1. Prepend a `0` filter byte to every scanline.
2. Compress with the runtime's `CompressionStream("deflate")` (which emits the zlib stream PNG's
   `IDAT` requires).
3. Wrap in `IHDR` / `IDAT` / `IEND` chunks, each with a CRC-32.

**Decode.** The RGBA buffer is copied into wasm memory, `jab_wasm_decode(ptr, width, height)` runs
detection and decoding, and the result bytes are copied out and decoded as UTF-8.

**Errors.** Failures from libjabcode are raised as `JabcodeError` and mapped to `422`. Everything
else is logged as structured JSON and returned as `500`.

**Concurrency.** The shim keeps its result in module-level state (bitmap / decoded data), which is
safe because encode and decode are fully synchronous within a request, and an isolate handles
JavaScript on a single thread. Do not introduce `await` between a `_jab_wasm_*` call and reading
its result.

## Project layout

| Path               | Purpose                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `index.js`         | Worker entry point: routing, wasm instantiation, base64 helpers, PNG encoder, error mapping. |
| `jabcode.js`       | JS wrapper around the wasm exports (`createJabcode`, `JabcodeError`, `encode`, `decode`). |
| `jabcode.mjs`      | Emscripten-generated loader, **modified** for Workers (see below).                        |
| `jabcode.wasm`     | libjabcode compiled to WebAssembly (~130 KB) with a small C shim.                         |
| `wrangler.toml`    | Worker name, entry point, compatibility date, observability.                              |
| `package.json`     | Declares `wrangler` as the only dependency.                                               |
| `.wrangler/`       | Local Wrangler state/cache (ignored by git).                                              |

## Configuration

### `wrangler.toml`

```toml
name = "jab"
main = "index.js"
compatibility_date = "2026-10-01"
workers_dev = true

[observability]
enabled = true
```

- `name` — the deployed Worker is named `jab` (`https://jab.<your-subdomain>.workers.dev`).
- `workers_dev = true` — publishes on the `workers.dev` subdomain.
- `observability` — enables Workers logs, so `console.log` / `console.error` output
  (including libjabcode's `JABCode Error: ...` messages) is captured.
- No bindings, secrets, or environment variables are required.

### Encoder settings

Encoding parameters are hard-coded in `index.js`:

```js
jab.encode(text, { colors: 8, moduleSize: 12, ecc: 3 });
```

| Option       | Values                                 | Meaning                                              |
| ------------ | -------------------------------------- | ---------------------------------------------------- |
| `colors`     | `4, 8, 16, 32, 64, 128, 256`           | Palette size. More colours = denser, harder to read. |
| `moduleSize` | pixels (`0` = library default)        | Size of each square module in the output image.      |
| `ecc`        | `0`–`10` (`0` = library default)       | Error-correction level.                              |

To expose these to callers, read them from `url.searchParams` in the `/encode` handler and
validate them before passing them through.

## The WebAssembly module

`jabcode.wasm` exports (names are minified by Emscripten; `jabcode.mjs` maps them back):

| Wasm export | JS name                    | Purpose                                         |
| ----------- | -------------------------- | ----------------------------------------------- |
| `i`         | `_malloc`                  | Allocate wasm memory.                           |
| `j`         | `_free`                    | Free wasm memory.                               |
| `l`         | `_jab_wasm_encode`         | Encode `(ptr, len, colors, moduleSize, ecc)`; returns `0` or a negative error. |
| `m` / `n`   | `_jab_wasm_bitmap_width` / `_height` | Dimensions of the encoded bitmap.     |
| `o`         | `_jab_wasm_bitmap_pixels`  | Pointer to RGBA pixels of the encoded bitmap.   |
| `p`         | `_jab_wasm_decode`         | Decode `(ptr, width, height)`; returns `0` or a negative error. |
| `q`         | `_jab_wasm_decode_status`  | `1` = symbol detected but not decodable.        |
| `r` / `s`   | `_jab_wasm_result_length` / `_result_data` | Decoded byte length and pointer. |
| `k`         | `_jab_wasm_free`           | Release the shim's bitmap/result buffers.       |
| `g`         | `memory`                   | Linear memory (initial 256 pages = 16 MiB, max 32768 pages = 2 GiB). |

Encode error codes: `-1` invalid arguments, `-2` out of memory, `-3` encoding failed. Decode
returns `-4` when nothing decodable was found.

The module imports only a small Emscripten runtime surface (`abort`, `emscripten_resize_heap`,
`fd_write` for `printf`/`stderr`, `proc_exit`, and a timer hook) — no WASI filesystem or network.

### Rebuilding the wasm

The C source for the shim and the build script are **not in this repository**. If you rebuild
`jabcode.wasm` from source with Emscripten, use settings that avoid Node-specific code, e.g.:

```
-sENVIRONMENT=web -sMODULARIZE -sEXPORT_ES6
```

and keep exporting the `_jab_wasm_*` functions plus `_malloc`/`_free`. After rebuilding, the
exported function letters may change, so regenerate `jabcode.mjs` rather than hand-editing it.

## Cloudflare-specific changes to the Emscripten loader

The stock Emscripten output failed at startup in `wrangler dev` with
`createRequire ... The argument 'path' ... Received 'undefined'`. Two reasons:

1. **Node detection.** workerd exposes `process.versions.node`, so the loader believed it was
   running under Node and tried to `import("node:module")` and read the `.wasm` from disk with `fs`.
2. **`import.meta.url`.** The loader used it to locate `jabcode.wasm`; it is not meaningful in a Worker.

`jabcode.mjs` was therefore edited to:

- Remove the Node / browser / web-worker environment detection and the `fs` / `XMLHttpRequest` /
  `fetch` code paths.
- Remove the default wasm-fetching logic (`findWasmBinary`, `instantiateAsync`, ...).
- Throw a clear error if no `instantiateWasm` option is supplied.

`jabcode.wasm` itself is unchanged. The Worker supplies the precompiled module through
`instantiateWasm`:

```js
const jab = await createJabcode({
  instantiateWasm(imports, onSuccess) {
    WebAssembly.instantiate(jabcodeWasm, imports).then((instance) =>
      onSuccess(instance, jabcodeWasm),
    );
    return {}; // tells Emscripten instantiation is asynchronous
  },
  print: (msg) => console.log(msg),
  printErr: (msg) => console.error(msg),
});
```

`WebAssembly.instantiate(module, imports)` resolves to an `Instance` (not `{ instance, module }`),
which is why `onSuccess` is called with both pieces explicitly.

## JS wrapper API (`jabcode.js`)

`jabcode.js` is usable on its own (it depends only on `jabcode.mjs`):

```js
import { createJabcode, JabcodeError } from "./jabcode.js";

const jab = await createJabcode({ instantiateWasm /* required on Workers */ });

const img = jab.encode("Hello", { colors: 8, moduleSize: 12, ecc: 3 });
// { width, height, data: Uint8ClampedArray (RGBA, ImageData-compatible) }

const bytes = jab.decode(img);          // Uint8Array
const text  = jab.decodeText(img);      // string
```

| Method                       | Returns                                        | Throws `JabcodeError` when                          |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| `encode(input, opts?)`       | `{ width, height, data }`                      | input empty / not string or `Uint8Array`; encode failure; OOM |
| `decode({ width, height, data })` | `Uint8Array`                              | `data.length !== width*height*4`; nothing decodable |
| `decodeText(image)`          | `string` (UTF-8)                               | same as `decode`                                    |

`encode` accepts either a string or arbitrary bytes (`Uint8Array`), so binary payloads work in the
wrapper even though the HTTP endpoint only exposes text.

## Deployment

```bash
npx wrangler login        # once
npx wrangler deploy
```

Wrangler bundles `index.js`, `jabcode.js`, `jabcode.mjs`, and uploads `jabcode.wasm` as a wasm
module (about 146 KiB / 62 KiB gzipped total). To check the bundle without deploying:

```bash
npx wrangler deploy --dry-run --outdir dist
```

To stream production logs: `npx wrangler tail`.

To use a custom domain or route, add a `routes` entry to `wrangler.toml`
([docs](https://developers.cloudflare.com/workers/configuration/routing/)) and remove or keep
`workers_dev` as you prefer.

## Performance and limits

- **Cold start:** the wasm instance is created once per isolate at module scope. After that, a
  request costs only encode/decode time (observed locally: roughly tens of milliseconds for a short
  string; actual numbers will vary with input size and Cloudflare's hardware).
- **Memory:** the wasm heap starts at 16 MiB and can grow, but Workers isolates are limited
  (128 MB at the time of writing); very large inputs/images can hit that ceiling.
- **Response size:** the `format=json` response base64-encodes raw pixels (~1.3 MB for a 500×500
  image), so prefer PNG unless you need pixels for `/decode`.
- **Caching:** PNG responses are `public, max-age=86400`. Cloudflare's CDN does not cache Worker
  responses on its own unless you use the Cache API or a route that does; add `caches.default`
  logic if you want edge caching.
- Check the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
  for CPU time, memory, and request body size on your plan.

## Troubleshooting

| Symptom                                                                 | Cause / fix                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `createRequire ... Received 'undefined'` at startup                     | An unmodified Emscripten loader is being used. Use the patched `jabcode.mjs` in this repo.  |
| `jabcode: pass an instantiateWasm option ...`                           | `createJabcode()` was called without `instantiateWasm`. Pass the bundled module (see above). |
| `Wasm code generation disallowed by embedder`                           | Something is compiling wasm from bytes at runtime. Import the `.wasm` file so Wrangler gives you a precompiled `WebAssembly.Module`. |
| `422 no decodable JABCode found (not detectable)`                       | No finder patterns: wrong dimensions, blank/cropped image, or image not RGBA.               |
| `422 data length must equal width * height * 4`                         | `rgba` isn't 4 bytes per pixel, or `width`/`height` are wrong (RGB data is a common cause). |
| `JABCode Error: Too few finder pattern found` in logs                   | Emitted by libjabcode on failed detection; accompanies the 422 above.                        |
| `500 internal error` on `/decode`                                       | Malformed JSON or invalid base64 in the request. Check `wrangler tail` for details.          |

## Known limitations

- **Raw RGBA only for decoding.** No PNG/JPEG decoding in the Worker.
- **Fixed encoder settings.** Colours, module size, and ECC are not caller-configurable over HTTP.
- **Text only over HTTP.** The wrapper supports bytes, but `/encode` takes a `text` query string
  (subject to URL length limits); there is no `POST /encode` for larger or binary payloads.
- **Single symbol.** Encoding produces a single symbol; if the payload doesn't fit, you get a `422`.
  The wrapper does not split data across multiple symbols.
- **Detection quality.** Decoding is designed for clean, axis-aligned renderings like those this
  Worker produces; real-world camera captures may not decode reliably.
- **No authentication or rate limiting.** Add them (Workers Rate Limiting, Cloudflare Access, or
  your own checks) before exposing publicly if abuse is a concern.
- **No automated tests.** `npm test` is a placeholder.
- **Modified Emscripten output.** `jabcode.mjs` is hand-patched; see
  [above](#cloudflare-specific-changes-to-the-emscripten-loader) before regenerating.

## Credits and licence

- [libjabcode](https://github.com/jabcode/jabcode) — the JAB Code reference implementation
  (LGPL-2.1 at the time of writing; verify the licence of the version you compiled and your
  obligations when distributing the wasm binary).
- JAB Code is specified in ISO/IEC 23634:2022.