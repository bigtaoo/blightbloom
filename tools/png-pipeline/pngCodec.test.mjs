import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { decodePNG, encodePNG, trimAlphaBoundingBox, boxDownsample, processPNG } from './pngCodec.mjs';

/** Build a synthetic RGBA8 image ({ width, height, data: Uint8Array }) from a per-pixel
 * generator so every test constructs its own known-good fixture instead of relying on
 * a checked-in binary PNG fixture file. */
function makeImage(width, height, pixelAt) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width, height, data };
}

function pixelAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

// Independent reference implementation of the standard PNG/zlib CRC-32 (same
// polynomial/table construction the codec itself uses internally for crc32(), but
// re-derived here from the spec rather than imported) — pngCodec.mjs does not export
// its internal crc32, and decodePNG does not re-verify chunk CRCs on the way in (it
// trusts the length field to skip the trailing 4 CRC bytes), so the only way to
// exercise crc32() without reaching into the module internals is to recompute the
// expected CRC for each chunk the encoder wrote and compare it against the bytes
// encodePNG actually emitted.
const REF_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function refCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = REF_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Parse a PNG buffer's chunk list without trusting pngCodec.mjs's own parser, so the
 * CRC test below stays independent of the code under test. */
function parseChunksIndependently(buf) {
  const chunks = [];
  let off = 8; // skip signature
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    chunks.push({ type, data, crc });
    off += 12 + len;
  }
  return chunks;
}

describe('decodePNG / encodePNG round trip', () => {
  it('round-trips a small RGBA image with varied alpha byte-for-byte', () => {
    const img = makeImage(5, 4, (x, y) => [
      (x * 37 + y * 11) & 0xff,
      (x * 53 + 7) & 0xff,
      (y * 29 + 3) & 0xff,
      [0, 64, 128, 255][(x + y) % 4],
    ]);
    const encoded = encodePNG(img);
    const decoded = decodePNG(encoded);
    expect(decoded.width).toBe(img.width);
    expect(decoded.height).toBe(img.height);
    expect(Array.from(decoded.data)).toEqual(Array.from(img.data));
  });

  it('round-trips a fully opaque image (exercises colorType 6 path with alpha=255 throughout)', () => {
    const img = makeImage(3, 3, (x, y) => [x * 80, y * 80, 128, 255]);
    const decoded = decodePNG(encodePNG(img));
    expect(Array.from(decoded.data)).toEqual(Array.from(img.data));
  });

  it('round-trips a single-pixel image', () => {
    const img = makeImage(1, 1, () => [10, 20, 30, 40]);
    const decoded = decodePNG(encodePNG(img));
    expect(decoded.width).toBe(1);
    expect(decoded.height).toBe(1);
    expect(Array.from(decoded.data)).toEqual([10, 20, 30, 40]);
  });

  it('produces a buffer starting with the PNG signature and IHDR/IDAT/IEND chunks in order', () => {
    const img = makeImage(2, 2, () => [1, 2, 3, 4]);
    const encoded = encodePNG(img);
    expect(Array.from(encoded.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks = parseChunksIndependently(encoded);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks[2].data.length).toBe(0); // IEND carries no data
    const ihdr = chunks[0].data;
    expect(ihdr.readUInt32BE(0)).toBe(2); // width
    expect(ihdr.readUInt32BE(4)).toBe(2); // height
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // color type RGBA
    expect(ihdr[12]).toBe(0); // interlace
  });

  it('rejects a buffer with a bad PNG signature', () => {
    const bogus = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0]);
    expect(() => decodePNG(bogus)).toThrow(/bad signature/);
  });

  it('rejects a buffer missing IHDR', () => {
    const sigOnly = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]);
    expect(() => decodePNG(sigOnly)).toThrow(/Missing IHDR/);
  });

  it('rejects an unsupported PNG shape (e.g. 16-bit depth)', () => {
    const img = makeImage(1, 1, () => [1, 2, 3, 4]);
    const encoded = encodePNG(img);
    // Flip the IHDR bit-depth byte (offset 8 within IHDR data, chunk data starts at
    // byte 16 of the file: 8 signature + 4 len + 4 type) from 8 to 16.
    const tampered = Buffer.from(encoded);
    tampered[16 + 8] = 16;
    expect(() => decodePNG(tampered)).toThrow(/Unsupported PNG shape/);
  });

  it('decodes a colorType-2 (RGB, no alpha) IHDR by synthesizing alpha=255', () => {
    // Build an RGB (no-alpha) PNG by hand: encodePNG only ever emits colorType 6, so
    // to exercise the colorType-2 decode path we assemble the IDAT ourselves from a
    // known-opaque RGBA source image, stripping the alpha byte per pixel.
    const width = 2, height = 2;
    const rgb = [
      [10, 20, 30], [40, 50, 60],
      [70, 80, 90], [100, 110, 120],
    ];
    const stride = width * 3;
    const filtered = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      filtered[y * (stride + 1)] = 0; // filter type 0 (None)
      for (let x = 0; x < width; x++) {
        const [r, g, b] = rgb[y * width + x];
        const destOff = y * (stride + 1) + 1 + x * 3;
        filtered[destOff] = r; filtered[destOff + 1] = g; filtered[destOff + 2] = b;
      }
    }
    const idatData = zlib.deflateSync(filtered, { level: 9 });
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 2; // color type RGB
    ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;

    function chunk(type, data) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      return Buffer.concat([len, typeAndData, Buffer.alloc(4)]); // CRC bytes unused by decodePNG
    }
    const buf = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdrData),
      chunk('IDAT', idatData),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const decoded = decodePNG(buf);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.data)).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255,
      70, 80, 90, 255, 100, 110, 120, 255,
    ]);
  });

  describe('colorType 3 (8-bit palette — what a libimagequant pass ships, 2026-09-28)', () => {
    function chunk(type, data) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // CRC unused
    }
    // A 3x2 image of palette indices. Row 0 uses filter None; row 1 uses Sub, so the one-byte
    // `bpp` of the unfilter loop is exercised (a Sub row stores index[x] - index[x-1]).
    function palettePNG({ plte, trns, rows = [[0, 1, 2], [2, 1, 0]] }) {
      const raw = Buffer.from([
        0, ...rows[0],
        1, rows[1][0], (rows[1][1] - rows[1][0]) & 0xff, (rows[1][2] - rows[1][1]) & 0xff,
      ]);
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(3, 0);
      ihdr.writeUInt32BE(2, 4);
      ihdr[8] = 8; ihdr[9] = 3;
      return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        ...(plte ? [chunk('PLTE', Buffer.from(plte))] : []),
        ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    }
    const PLTE = [10, 20, 30, 40, 50, 60, 70, 80, 90];

    it('expands indices through PLTE, alpha from tRNS, and 255 past the end of a short tRNS', () => {
      const decoded = decodePNG(palettePNG({ plte: PLTE, trns: [0, 128] }));
      expect(decoded.width).toBe(3);
      expect(Array.from(decoded.data)).toEqual([
        10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255,
        70, 80, 90, 255, 40, 50, 60, 128, 10, 20, 30, 0,
      ]);
    });

    it('is fully opaque with no tRNS at all', () => {
      const alphas = Array.from(decodePNG(palettePNG({ plte: PLTE })).data).filter((_, i) => i % 4 === 3);
      expect(alphas).toEqual([255, 255, 255, 255, 255, 255]);
    });

    it('refuses a palette file with no PLTE, or an index past its end, rather than inventing a colour', () => {
      expect(() => decodePNG(palettePNG({}))).toThrow(/no PLTE/);
      expect(() => decodePNG(palettePNG({ plte: PLTE, rows: [[0, 1, 3], [0, 0, 0]] }))).toThrow(/index 3 past the 3-entry/);
    });
  });
});

describe('crc32 (indirect, via encodePNG output)', () => {
  it('writes chunk CRCs matching an independently-derived CRC-32 for every chunk', () => {
    const img = makeImage(4, 3, (x, y) => [x * 10, y * 10, 5, 200]);
    const encoded = encodePNG(img);
    const chunks = parseChunksIndependently(encoded);
    expect(chunks.length).toBeGreaterThan(0);
    for (const { type, data, crc } of chunks) {
      const expected = refCrc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
      expect(crc).toBe(expected);
    }
  });

  it('matches the well-known reference CRC-32 for an empty IEND chunk', () => {
    // "IEND" + zero-length data has a widely documented fixed CRC of 0xAE426082 —
    // cross-checking the reference helper itself against that public constant, then
    // relying on the chunk-by-chunk comparison above to transitively validate the
    // codec's internal crc32() against the same reference implementation.
    expect(refCrc32(Buffer.from('IEND', 'ascii'))).toBe(0xae426082);
  });
});

describe('trimAlphaBoundingBox', () => {
  it('crops to the bounding box of non-zero-alpha pixels', () => {
    // 6x6 image, fully transparent except for a 3x3 opaque block at (2,2)-(4,4).
    const img = makeImage(6, 6, (x, y) => {
      if (x >= 2 && x <= 4 && y >= 2 && y <= 4) return [x * 10, y * 10, 1, 200];
      return [255, 0, 0, 0]; // transparent border; RGB is garbage on purpose
    });
    const trimmed = trimAlphaBoundingBox(img);
    expect(trimmed.width).toBe(3);
    expect(trimmed.height).toBe(3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        expect(pixelAt(trimmed, x, y)).toEqual([(x + 2) * 10, (y + 2) * 10, 1, 200]);
      }
    }
  });

  it('returns the same image reference when already tightly cropped (no-op)', () => {
    const img = makeImage(2, 2, () => [1, 2, 3, 255]);
    expect(trimAlphaBoundingBox(img)).toBe(img);
  });

  it('returns the same image reference when fully transparent (nothing to trim)', () => {
    const img = makeImage(4, 4, () => [0, 0, 0, 0]);
    expect(trimAlphaBoundingBox(img)).toBe(img);
  });

  it('crops an asymmetric single-pixel bounding box correctly', () => {
    const img = makeImage(5, 5, (x, y) => (x === 4 && y === 0 ? [9, 8, 7, 6] : [0, 0, 0, 0]));
    const trimmed = trimAlphaBoundingBox(img);
    expect(trimmed.width).toBe(1);
    expect(trimmed.height).toBe(1);
    expect(pixelAt(trimmed, 0, 0)).toEqual([9, 8, 7, 6]);
  });
});

describe('boxDownsample', () => {
  it('averages a 4x4 image of four solid-color 2x2 quadrants down to 2x2', () => {
    const quadrantColor = (qx, qy) => [[[10, 20, 30, 255], [40, 50, 60, 255]], [[70, 80, 90, 255], [100, 110, 120, 255]]][qy][qx];
    const img = makeImage(4, 4, (x, y) => quadrantColor(x >> 1, y >> 1));
    const out = boxDownsample(img, 2);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(pixelAt(out, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(pixelAt(out, 1, 0)).toEqual([40, 50, 60, 255]);
    expect(pixelAt(out, 0, 1)).toEqual([70, 80, 90, 255]);
    expect(pixelAt(out, 1, 1)).toEqual([100, 110, 120, 255]);
  });

  it('weights RGB by alpha when averaging a quadrant with mixed transparency', () => {
    // Top-left 2x2 quadrant: one opaque red pixel, one opaque blue pixel, and two
    // fully-transparent (alpha=0) pixels carrying garbage RGB that must NOT bleed
    // into the average since boxDownsample premultiplies by alpha before summing.
    const img = makeImage(2, 2, (x, y) => {
      if (x === 0 && y === 0) return [255, 0, 0, 255];
      if (x === 1 && y === 0) return [0, 0, 255, 255];
      return [999 & 0xff, 999 & 0xff, 999 & 0xff, 0]; // transparent garbage
    });
    const out = boxDownsample(img, 1);
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    // Alpha-weighted average over 4 samples, two of which contribute weight 0:
    // R = (255*255 + 0*255) / (255+255) = 127.5 -> rounds to 128; alpha avg = (255+255+0+0)/4 = 127.5 -> 128
    const [r, g, b, a] = pixelAt(out, 0, 0);
    expect(r).toBe(128);
    expect(g).toBe(0);
    expect(b).toBe(128);
    expect(a).toBe(128);
  });

  it('is a no-op when the image is already within the target long axis', () => {
    const img = makeImage(3, 2, () => [1, 2, 3, 4]);
    expect(boxDownsample(img, 10)).toBe(img);
    expect(boxDownsample(img, 3)).toBe(img); // equal to target still counts as no-op
  });

  it('sets alpha to 0 (not NaN) for an output pixel with no opaque source samples', () => {
    const img = makeImage(2, 2, () => [0, 0, 0, 0]); // fully transparent
    const out = boxDownsample(img, 1);
    expect(pixelAt(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('processPNG — trim: false', () => {
  /** The rig-art case (2026-08-25 WeChat downsampling pass). A bone's PNG is bound by
   *  `animation.json` with `scale = authoringPx / sourceWidth` and pivoted at the canvas
   *  centre, so the transparent margin is load-bearing geometry: trimming it changes both
   *  the rendered size and where the bone sits. `trim: false` is what makes re-encoding a
   *  bone texture a pure change of divisor. */
  const bordered = () =>
    makeImage(8, 8, (x, y) =>
      x >= 2 && x < 6 && y >= 2 && y < 6 ? [200, 20, 20, 255] : [0, 0, 0, 0],
    );

  it('keeps the full canvas, so the opaque content stays centred at the same fraction', () => {
    const result = processPNG(encodePNG(bordered()), { targetLongAxis: 4, trim: false });
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    const out = decodePNG(result.buffer);
    // The 4x4 opaque block occupied the middle half of an 8x8 canvas; at 4x4 that is the
    // middle 2x2. Corners stay transparent — with trimming they would be opaque.
    expect(pixelAt(out, 0, 0)[3]).toBe(0);
    expect(pixelAt(out, 3, 3)[3]).toBe(0);
    expect(pixelAt(out, 1, 1)).toEqual([200, 20, 20, 255]);
    expect(pixelAt(out, 2, 2)).toEqual([200, 20, 20, 255]);
  });

  it('differs from the trimming default on the same input', () => {
    const input = encodePNG(bordered());
    const trimmed = processPNG(input, { targetLongAxis: 4 });
    const kept = processPNG(input, { targetLongAxis: 4, trim: false });
    // Trimming crops to the 4x4 block first, so its 4x4 output is entirely opaque.
    expect(pixelAt(decodePNG(trimmed.buffer), 0, 0)[3]).toBe(255);
    expect(pixelAt(decodePNG(kept.buffer), 0, 0)[3]).toBe(0);
  });

  it('still reports the original dimensions and still round-trip-verifies', () => {
    const result = processPNG(encodePNG(bordered()), { targetLongAxis: 4, trim: false });
    expect(result.originalWidth).toBe(8);
    expect(result.originalHeight).toBe(8);
    expect(decodePNG(result.buffer).width).toBe(4);
  });
});

describe('processPNG', () => {
  it('composes trim + downsample + encode and round-trip-verifies the result', () => {
    // 8x8 source: transparent border, with a 4x4 opaque block of two solid-color
    // 2x2 quadrants inside it (so trimming AND downsampling both do real work).
    const img = makeImage(8, 8, (x, y) => {
      if (x >= 2 && x < 6 && y >= 2 && y < 6) {
        const qx = x < 4 ? 0 : 1;
        const qy = y < 4 ? 0 : 1;
        return qx === qy ? [200, 20, 20, 255] : [20, 20, 200, 255];
      }
      return [0, 0, 0, 0];
    });
    const inputBuf = encodePNG(img);
    const result = processPNG(inputBuf, { targetLongAxis: 2 });

    expect(result.originalWidth).toBe(8);
    expect(result.originalHeight).toBe(8);
    // Trimmed to the 4x4 opaque block, then downsampled to long-axis 2 -> 2x2.
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);

    const decoded = decodePNG(result.buffer);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(pixelAt(decoded, 0, 0)).toEqual([200, 20, 20, 255]);
    expect(pixelAt(decoded, 1, 1)).toEqual([200, 20, 20, 255]);
    expect(pixelAt(decoded, 1, 0)).toEqual([20, 20, 200, 255]);
    expect(pixelAt(decoded, 0, 1)).toEqual([20, 20, 200, 255]);
  });

  it('defaults targetLongAxis to 320 (no-op downsample for images already smaller)', () => {
    const img = makeImage(10, 6, (x, y) => [x * 5, y * 5, 0, 255]); // fully opaque, nothing to trim
    const inputBuf = encodePNG(img);
    const result = processPNG(inputBuf);
    expect(result.width).toBe(10);
    expect(result.height).toBe(6);
    expect(result.originalWidth).toBe(10);
    expect(result.originalHeight).toBe(6);
  });
});
