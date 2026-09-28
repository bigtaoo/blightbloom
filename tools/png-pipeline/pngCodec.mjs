/**
 * Pure-Node PNG decode/encode for 8-bit RGBA, non-interlaced PNGs (fs+zlib only,
 * no sharp/pngquant/etc — this repo's art assets are consistently colorType=6,
 * bitDepth=8, interlace=0, e.g. GPT Image 2 exports and this pipeline's own
 * re-encodes, so that's the only shape this codec ENCODES; it also DECODES RGB and 8-bit
 * palette files, the latter since the lobby art went through libimagequant, 2026-09-28,
 * so the shipped-art tests can still read what ships). Re-created
 * 2026-07-28 for the asset-size audit follow-up (the original weapon-art pipeline
 * session's codec was never committed as a reusable tool — this one is, so it
 * doesn't need re-deriving a third time).
 */
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG (bad signature)');
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 12 + len; // len + type(4) + data + crc(4)
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode an 8-bit non-interlaced PNG buffer (RGBA or RGB — a flat background image
 * with no transparency, e.g. a hub/menu backdrop, commonly exports as colorType 2 — or
 * 8-bit PALETTE, colorType 3, which is what a libimagequant/pngquant pass ships: the lobby
 * portraits and logos since 2026-09-28) into { width, height, data: Uint8Array } — always
 * normalized to RGBA8 (opaque alpha=255 synthesized for colorType 2, and for any palette
 * entry past the end of tRNS) so every other function in this module only ever deals with
 * one pixel shape. */
export function decodePNG(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('Missing IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2 && colorType !== 3) || interlace !== 0) {
    throw new Error(`Unsupported PNG shape (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}) — this codec only handles 8-bit RGB/RGBA/palette non-interlaced`);
  }
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);

  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1; // RGBA8, RGB8, or a palette index
  const stride = width * bpp;
  const unfiltered = new Uint8Array(width * height * bpp);
  let rawOff = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOff]; rawOff += 1;
    const rowOff = y * stride;
    const prevRowOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const raw_x = raw[rawOff + x];
      const a = x >= bpp ? unfiltered[rowOff + x - bpp] : 0;
      const b = y > 0 ? unfiltered[prevRowOff + x] : 0;
      const c = y > 0 && x >= bpp ? unfiltered[prevRowOff + x - bpp] : 0;
      let value;
      switch (filterType) {
        case 0: value = raw_x; break;
        case 1: value = raw_x + a; break;
        case 2: value = raw_x + b; break;
        case 3: value = raw_x + ((a + b) >> 1); break;
        case 4: value = raw_x + paeth(a, b, c); break;
        default: throw new Error(`Unknown filter type ${filterType}`);
      }
      unfiltered[rowOff + x] = value & 0xff;
    }
    rawOff += stride;
  }
  if (bpp === 4) return { width, height, data: unfiltered };
  if (bpp === 1) return { width, height, data: expandPalette(chunks, unfiltered) };

  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < unfiltered.length; i += 3, j += 4) {
    out[j] = unfiltered[i];
    out[j + 1] = unfiltered[i + 1];
    out[j + 2] = unfiltered[i + 2];
    out[j + 3] = 255;
  }
  return { width, height, data: out };
}

/** Palette indices -> RGBA8. An index with no PLTE entry is a corrupt file, not a colour. */
function expandPalette(chunks, indices) {
  const plte = chunks.find((c) => c.type === 'PLTE');
  if (!plte) throw new Error('Palette PNG with no PLTE chunk');
  const trns = chunks.find((c) => c.type === 'tRNS')?.data ?? new Uint8Array(0);
  const entries = plte.data.length / 3;
  const out = new Uint8Array(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const k = indices[i];
    if (k >= entries) throw new Error(`Palette index ${k} past the ${entries}-entry PLTE`);
    out[i * 4] = plte.data[k * 3];
    out[i * 4 + 1] = plte.data[k * 3 + 1];
    out[i * 4 + 2] = plte.data[k * 3 + 2];
    out[i * 4 + 3] = k < trns.length ? trns[k] : 255;
  }
  return out;
}

/** Encode { width, height, data: Uint8Array RGBA8 } into a PNG buffer, with per-row adaptive filtering. */
export function encodePNG({ width, height, data }) {
  const bpp = 4;
  const stride = width * bpp;
  const filtered = Buffer.alloc((stride + 1) * height);

  // Scratch buffers for each candidate filter's output for the current row, so we
  // can pick the one with the smallest sum-of-abs-signed-byte-values heuristic
  // (the standard adaptive-filter heuristic — minimizes entropy fed to deflate).
  const candidates = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];

  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    const prevRowOff = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const raw_x = data[rowOff + x];
      const a = x >= bpp ? data[rowOff + x - bpp] : 0;
      const b = y > 0 ? data[prevRowOff + x] : 0;
      const c = y > 0 && x >= bpp ? data[prevRowOff + x - bpp] : 0;
      candidates[0][x] = raw_x;
      candidates[1][x] = (raw_x - a) & 0xff;
      candidates[2][x] = (raw_x - b) & 0xff;
      candidates[3][x] = (raw_x - ((a + b) >> 1)) & 0xff;
      candidates[4][x] = (raw_x - paeth(a, b, c)) & 0xff;
    }
    let bestType = 0, bestSum = Infinity;
    for (let t = 0; t < 5; t++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = candidates[t][x];
        sum += v < 128 ? v : 256 - v; // signed-byte magnitude heuristic
      }
      if (sum < bestSum) { bestSum = sum; bestType = t; }
    }
    const destOff = y * (stride + 1);
    filtered[destOff] = bestType;
    filtered.set(candidates[bestType], destOff + 1);
  }

  const idatData = zlib.deflateSync(filtered, { level: 9 });

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;

  return Buffer.concat([
    SIGNATURE,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', idatData),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** Crop to the bounding box of non-zero-alpha pixels. Returns the same image unchanged if fully opaque/transparent-free crop would be a no-op. */
export function trimAlphaBoundingBox(img) {
  const { width, height, data } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return img; // fully transparent, nothing to trim
  const outW = maxX - minX + 1;
  const outH = maxY - minY + 1;
  if (outW === width && outH === height) return img;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const srcRow = (minY + y) * width + minX;
    const dstRow = y * outW;
    out.set(data.subarray(srcRow * 4, (srcRow + outW) * 4), dstRow * 4);
  }
  return { width: outW, height: outH, data: out };
}

/** Box-filter downsample so the longer axis is at most targetLongAxis (no-op if already smaller). Premultiplies by alpha before averaging so transparent pixels don't bleed their (often garbage) RGB into the edge. */
export function boxDownsample(img, targetLongAxis) {
  const { width, height, data } = img;
  const longAxis = Math.max(width, height);
  if (longAxis <= targetLongAxis) return img;
  const scale = targetLongAxis / longAxis;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    const sy0 = Math.floor((oy / outH) * height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) / outH) * height));
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = Math.floor((ox / outW) * width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) / outW) * width));
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * width + sx) * 4;
          const a = data[i + 3];
          rSum += data[i] * a; gSum += data[i + 1] * a; bSum += data[i + 2] * a;
          aSum += a; n++;
        }
      }
      const oi = (oy * outW + ox) * 4;
      if (aSum > 0) {
        out[oi] = Math.round(rSum / aSum);
        out[oi + 1] = Math.round(gSum / aSum);
        out[oi + 2] = Math.round(bSum / aSum);
      }
      out[oi + 3] = Math.round(aSum / n);
    }
  }
  return { width: outW, height: outH, data: out };
}

function imagesEqual(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/**
 * Trim + downsample + re-encode a PNG buffer, round-trip-verifying the output decodes back to the exact pre-encode pixels before returning it. Throws rather than silently shipping a mismatched encode.
 *
 * `trim: false` skips the alpha-bbox crop, which matters for any art whose CANVAS carries
 * meaning. A rig bone's PNG is one: `animation.json` binds it with a scale that is exactly
 * `authoringPx / sourceWidth` and pins it by its centre, so cropping the transparent margin
 * moves both the size and the pivot, while a pure downsample only changes the divisor.
 * Untrimmed output is also SMALLER here in practice — the fully transparent rows either side
 * cost almost nothing once deflated, whereas a cropped image is dense pixels edge to edge.
 */
export function processPNG(inputBuf, { targetLongAxis = 320, trim = true } = {}) {
  const decoded = decodePNG(inputBuf);
  const trimmed = trim ? trimAlphaBoundingBox(decoded) : decoded;
  const resized = boxDownsample(trimmed, targetLongAxis);
  const encoded = encodePNG(resized);
  const roundTrip = decodePNG(encoded);
  if (!imagesEqual(resized, roundTrip)) {
    throw new Error('Round-trip verification failed: re-decoded output does not match the pre-encode pixels');
  }
  return { buffer: encoded, width: resized.width, height: resized.height, originalWidth: decoded.width, originalHeight: decoded.height };
}
