import { createJabcode, JabcodeError } from "./jabcode.js";
import jabcodeWasm from "./jabcode.wasm"; // WebAssembly.Module, bundled by Wrangler

// Instantiate once at module scope, not per request. The Emscripten loader must be
// told to use the bundled module instead of fetching/compiling the .wasm itself.
const jab = await createJabcode({
  instantiateWasm(imports, onSuccess) {
    WebAssembly.instantiate(jabcodeWasm, imports).then((instance) =>
      onSuccess(instance, jabcodeWasm),
    );
    return {}; // tells Emscripten the instantiation is async
  },
  print: (msg) => console.log(msg),
  printErr: (msg) => console.error(msg),
});

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Encode RGBA pixels as a PNG. Uses the runtime's CompressionStream for the zlib data.
async function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height); // each scanline prefixed with filter byte 0
  for (let y = 0; y < height; y++) {
    raw.set(
      new Uint8Array(data.buffer, data.byteOffset + y * stride, stride),
      y * (stride + 1) + 1,
    );
  }
  const idat = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer(),
  );

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  return new Blob(parts);
}

function fromBase64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      // GET /encode?text=hello  ->  image/png
      // GET /encode?text=hello&format=json  ->  { width, height, rgba: <base64> }
      if (request.method === "GET" && url.pathname === "/encode") {
        const text = url.searchParams.get("text");
        if (!text) return Response.json({ error: "missing ?text=" }, { status: 400 });
        const img = jab.encode(text, { colors: 8, moduleSize: 12, ecc: 3 });
        // ?format=json returns raw RGBA (base64), which is what POST /decode accepts.
        if (url.searchParams.get("format") === "json") {
          return Response.json({
            width: img.width,
            height: img.height,
            rgba: toBase64(new Uint8Array(img.data.buffer)),
          });
        }
        return new Response(await encodePng(img), {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
        });
      }

      // POST /decode  { width, height, rgba: <base64> }  ->  { text }
      if (request.method === "POST" && url.pathname === "/decode") {
        const { width, height, rgba } = await request.json();
        const text = jab.decodeText({ width, height, data: fromBase64(rgba) });
        return Response.json({ text });
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      if (err instanceof JabcodeError) {
        return Response.json({ error: err.message }, { status: 422 });
      }
      console.error(JSON.stringify({ msg: "unhandled error", error: String(err) }));
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },
};