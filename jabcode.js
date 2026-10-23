// JS wrapper around the libjabcode WASM module.
//
//   import { createJabcode } from './jabcode.js';
//   const jab = await createJabcode();
//   const img = jab.encode('Hello', { colors: 8, moduleSize: 12, ecc: 3 });
//   const bytes = jab.decode(img);          // Uint8Array
//   new TextDecoder().decode(bytes);        // 'Hello'

import createModule from './jabcode.mjs';

export class JabcodeError extends Error {}

const ENCODE_ERRORS = {
  '-1': 'invalid arguments',
  '-2': 'out of memory',
  '-3': 'encoding failed (data too large for a single symbol, or invalid options)',
};

export async function createJabcode(moduleOverrides = {}) {
  const m = await createModule(moduleOverrides);

  return {
    /**
     * Encode text (string) or bytes (Uint8Array) as a JABCode.
     * @param {string|Uint8Array} input
     * @param {{colors?: number, moduleSize?: number, ecc?: number}} [opts]
     *   colors: 4|8|16|32|64|128|256 (default 8); moduleSize: pixels (default 12);
     *   ecc: 0..10 (0/default = library default).
     * @returns {{width: number, height: number, data: Uint8ClampedArray}} RGBA, ImageData-compatible
     */
    encode(input, { colors = 8, moduleSize = 0, ecc = 0 } = {}) {
      const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw new JabcodeError('input must be a non-empty string or Uint8Array');
      }
      const ptr = m._malloc(bytes.length);
      if (!ptr) throw new JabcodeError('out of memory');
      try {
        m.HEAPU8.set(bytes, ptr);
        const rc = m._jab_wasm_encode(ptr, bytes.length, colors, moduleSize, ecc);
        if (rc !== 0) throw new JabcodeError(ENCODE_ERRORS[rc] ?? `encode error ${rc}`);
      } finally {
        m._free(ptr);
      }
      const width = m._jab_wasm_bitmap_width();
      const height = m._jab_wasm_bitmap_height();
      const pix = m._jab_wasm_bitmap_pixels();
      // slice() copies out of the WASM heap, so the result survives memory growth / free.
      const data = new Uint8ClampedArray(m.HEAPU8.slice(pix, pix + width * height * 4).buffer);
      m._jab_wasm_free();
      return { width, height, data };
    },

    /**
     * Decode a JABCode from RGBA pixels.
     * @param {{width: number, height: number, data: Uint8Array|Uint8ClampedArray}} image
     * @returns {Uint8Array} decoded bytes
     * @throws {JabcodeError} if no code could be detected/decoded
     */
    decode({ width, height, data }) {
      if (data.length !== width * height * 4) {
        throw new JabcodeError('data length must equal width * height * 4 (RGBA)');
      }
      const ptr = m._malloc(data.length);
      if (!ptr) throw new JabcodeError('out of memory');
      try {
        m.HEAPU8.set(data, ptr);
        const rc = m._jab_wasm_decode(ptr, width, height);
        if (rc !== 0) {
          const status = m._jab_wasm_decode_status();
          m._jab_wasm_free();
          throw new JabcodeError(
            rc === -4
              ? `no decodable JABCode found (${status === 1 ? 'detected but not decodable' : 'not detectable'})`
              : `decode error ${rc}`,
          );
        }
      } finally {
        m._free(ptr);
      }
      const len = m._jab_wasm_result_length();
      const out = m._jab_wasm_result_data();
      const result = m.HEAPU8.slice(out, out + len);
      m._jab_wasm_free();
      return result;
    },

    /** Same as decode() but returns a UTF-8 string. */
    decodeText(image) {
      return new TextDecoder().decode(this.decode(image));
    },
  };
}
