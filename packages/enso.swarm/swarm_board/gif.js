// Self-contained GIF89a animated encoder for the Swarm Graph export.
//
// Zero external dependencies:
// - Exact-palette fast path when the animation uses <= 255 distinct colors
//   (typical for the monochrome swarm graph UI), falling back to 5-bit
//   median-cut quantization for color-rich inputs.
// - Variable-width LSB-first GIF LZW compression with open-addressed hashing.
// - Delta sub-frame cropping with transparency (disposal method 1) so
//   unchanged background pixels cost almost nothing in time or file size.
//
// Loaded as a plain browser script (exposing globalThis.SwarmGif) and also
// importable under Node for unit tests.
(() => {
  const HASH_SIZE = 5003; // prime > 4096 (max 12-bit LZW code table size)

  class ByteWriter {
    constructor(cap = 65536) {
      this.buf = new Uint8Array(cap);
      this.len = 0;
    }
    ensure(n) {
      if (this.len + n <= this.buf.length) return;
      let next = this.buf.length;
      while (next < this.len + n) next *= 2;
      const grown = new Uint8Array(next);
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    u8(v) {
      this.ensure(1);
      this.buf[this.len++] = v & 0xff;
    }
    u16(v) {
      this.ensure(2);
      this.buf[this.len++] = v & 0xff;
      this.buf[this.len++] = (v >> 8) & 0xff;
    }
    ascii(s) {
      this.ensure(s.length);
      for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xff;
    }
    bytes(arr) {
      this.ensure(arr.length);
      this.buf.set(arr, this.len);
      this.len += arr.length;
    }
    finish() {
      return this.buf.slice(0, this.len);
    }
  }

  // Builds a global RGB palette of at most `maxColors` opaque colors across all
  // RGBA frames, plus an optional reserved slot for delta transparency.
  // Returns `{ palette, colorBits, tableSize, transparentIndex, mapFrame }`.
  function quantize(rgbaFrames, { maxColors = 255, reserveTransparent = true } = {}) {
    const limit = Math.max(2, Math.min(reserveTransparent ? 255 : 256, maxColors | 0));
    const exact = new Map(); // rgb24 -> index
    let overflow = false;

    // Fast exact-palette pass: run-length skip handles flat UI backgrounds quickly.
    for (let f = 0; f < rgbaFrames.length && !overflow; f++) {
      const data = rgbaFrames[f];
      let lastRgb = -1;
      for (let i = 0; i < data.length; i += 4) {
        const rgb = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        if (rgb === lastRgb) continue;
        lastRgb = rgb;
        if (!exact.has(rgb)) {
          if (exact.size >= limit) {
            overflow = true;
            break;
          }
          exact.set(rgb, exact.size);
        }
      }
    }

    if (!overflow) {
      const count = Math.max(1, exact.size);
      const needed = count + (reserveTransparent ? 1 : 0);
      const colorBits = Math.max(1, Math.min(8, Math.ceil(Math.log2(Math.max(2, needed)))));
      const tableSize = 1 << colorBits;
      const palette = new Uint8Array(tableSize * 3);
      for (const [rgb, idx] of exact) {
        palette[idx * 3] = (rgb >> 16) & 0xff;
        palette[idx * 3 + 1] = (rgb >> 8) & 0xff;
        palette[idx * 3 + 2] = rgb & 0xff;
      }
      const transparentIndex = reserveTransparent ? count : -1;
      const nearestExact = (r, g, b) => {
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < count; i++) {
          const dr = r - palette[i * 3];
          const dg = g - palette[i * 3 + 1];
          const db = b - palette[i * 3 + 2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bestDist) {
            bestDist = d;
            best = i;
            if (d === 0) break;
          }
        }
        return best;
      };
      const mapFrame = (rgba, out) => {
        let lastRgb = -1;
        let lastIdx = 0;
        for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
          const r = rgba[i];
          const g = rgba[i + 1];
          const b = rgba[i + 2];
          const rgb = (r << 16) | (g << 8) | b;
          if (rgb !== lastRgb) {
            lastRgb = rgb;
            let idx = exact.get(rgb);
            if (idx === undefined) {
              idx = nearestExact(r, g, b);
              exact.set(rgb, idx);
            }
            lastIdx = idx;
          }
          out[p] = lastIdx;
        }
      };
      return { palette, colorBits, tableSize, transparentIndex, mapFrame };
    }

    // General path: 5-bit per channel histogram + median cut.
    const counts = new Uint32Array(32768);
    const sumR = new Float64Array(32768);
    const sumG = new Float64Array(32768);
    const sumB = new Float64Array(32768);
    let totalPixels = 0;
    for (let f = 0; f < rgbaFrames.length; f++) totalPixels += rgbaFrames[f].length >>> 2;
    const stride = Math.max(1, Math.floor(totalPixels / 4000000));
    const byteStep = stride * 4;

    for (let f = 0; f < rgbaFrames.length; f++) {
      const data = rgbaFrames[f];
      const offset = (f % stride) * 4;
      for (let i = offset; i < data.length; i += byteStep) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const q = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        counts[q]++;
        sumR[q] += r;
        sumG[q] += g;
        sumB[q] += b;
      }
    }

    const buckets = [];
    for (let q = 0; q < 32768; q++) {
      const c = counts[q];
      if (!c) continue;
      buckets.push({
        r: (q >> 10) & 31,
        g: (q >> 5) & 31,
        b: q & 31,
        c,
        sr: sumR[q],
        sg: sumG[q],
        sb: sumB[q],
      });
    }

    const makeBox = (items) => {
      let rMin = 31, rMax = 0, gMin = 31, gMax = 0, bMin = 31, bMax = 0, total = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.r < rMin) rMin = it.r;
        if (it.r > rMax) rMax = it.r;
        if (it.g < gMin) gMin = it.g;
        if (it.g > gMax) gMax = it.g;
        if (it.b < bMin) bMin = it.b;
        if (it.b > bMax) bMax = it.b;
        total += it.c;
      }
      const rRange = rMax - rMin;
      const gRange = gMax - gMin;
      const bRange = bMax - bMin;
      const span = Math.max(rRange, gRange, bRange);
      const axis = span === rRange ? 'r' : span === gRange ? 'g' : 'b';
      return { items, total, axis, score: items.length > 1 ? span * Math.sqrt(total) : -1 };
    };

    const boxes = buckets.length ? [makeBox(buckets)] : [];
    while (boxes.length < limit) {
      let bestIdx = -1;
      let bestScore = 0;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].score > bestScore) {
          bestScore = boxes[i].score;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      const box = boxes[bestIdx];
      const axis = box.axis;
      box.items.sort((a, b) => a[axis] - b[axis]);
      const half = box.total / 2;
      let acc = 0;
      let split = 1;
      for (let i = 0; i < box.items.length - 1; i++) {
        acc += box.items[i].c;
        if (acc >= half) {
          split = i + 1;
          break;
        }
      }
      const left = makeBox(box.items.slice(0, split));
      const right = makeBox(box.items.slice(split));
      boxes[bestIdx] = left;
      boxes.push(right);
    }

    const count = Math.max(1, boxes.length);
    const needed = count + (reserveTransparent ? 1 : 0);
    const colorBits = Math.max(1, Math.min(8, Math.ceil(Math.log2(Math.max(2, needed)))));
    const tableSize = 1 << colorBits;
    const palette = new Uint8Array(tableSize * 3);
    for (let i = 0; i < boxes.length; i++) {
      const items = boxes[i].items;
      let sr = 0, sg = 0, sb = 0, sc = 0;
      for (let j = 0; j < items.length; j++) {
        sr += items[j].sr;
        sg += items[j].sg;
        sb += items[j].sb;
        sc += items[j].c;
      }
      palette[i * 3] = Math.round(sr / sc);
      palette[i * 3 + 1] = Math.round(sg / sc);
      palette[i * 3 + 2] = Math.round(sb / sc);
    }

    const transparentIndex = reserveTransparent ? count : -1;
    const lut = new Int16Array(32768).fill(-1);
    const nearest = (r, g, b) => {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < count; i++) {
        const dr = r - palette[i * 3];
        const dg = g - palette[i * 3 + 1];
        const db = b - palette[i * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) {
          bestDist = d;
          best = i;
          if (d === 0) break;
        }
      }
      return best;
    };

    const mapFrame = (rgba, out) => {
      let lastQ = -1;
      let lastIdx = 0;
      for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        const q = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        if (q !== lastQ) {
          lastQ = q;
          let idx = lut[q];
          if (idx < 0) {
            const c = counts[q];
            idx = c > 0
              ? nearest(sumR[q] / c, sumG[q] / c, sumB[q] / c)
              : nearest((q >> 10) * 8 + 4, ((q >> 5) & 31) * 8 + 4, (q & 31) * 8 + 4);
            lut[q] = idx;
          }
          lastIdx = idx;
        }
        out[p] = lastIdx;
      }
    };
    return { palette, colorBits, tableSize, transparentIndex, mapFrame };
  }

  // Writes GIF LZW sub-blocks (including minCodeSize prefix and 0x00
  // terminator) for `indices` into `writer`.
  function writeLzw(writer, indices, minCodeSize, hashKeys, hashVals) {
    const lzwMin = Math.max(2, minCodeSize);
    writer.u8(lzwMin);

    const clearCode = 1 << lzwMin;
    const eoiCode = clearCode + 1;
    let nextCode = eoiCode + 1;
    let codeSize = lzwMin + 1;
    let maxForSize = 1 << codeSize;
    hashKeys.fill(-1);

    const sub = new Uint8Array(255);
    let subLen = 0;
    let bitBuf = 0;
    let bitCount = 0;

    const flushSub = () => {
      if (subLen === 0) return;
      writer.u8(subLen);
      writer.bytes(sub.subarray(0, subLen));
      subLen = 0;
    };
    const emit = (code, bits) => {
      bitBuf |= code << bitCount;
      bitCount += bits;
      while (bitCount >= 8) {
        sub[subLen++] = bitBuf & 0xff;
        if (subLen === 255) flushSub();
        bitBuf >>>= 8;
        bitCount -= 8;
      }
    };

    emit(clearCode, codeSize);
    if (indices.length > 0) {
      let prefix = indices[0];
      for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        let h = (Math.imul(key, 2654435761) >>> 0) % HASH_SIZE;
        let found = -1;
        while (hashKeys[h] !== -1) {
          if (hashKeys[h] === key) {
            found = hashVals[h];
            break;
          }
          h = h + 1 === HASH_SIZE ? 0 : h + 1;
        }
        if (found >= 0) {
          prefix = found;
        } else {
          emit(prefix, codeSize);
          if (nextCode < 4096) {
            if (nextCode === maxForSize && codeSize < 12) {
              codeSize++;
              maxForSize = 1 << codeSize;
            }
            hashKeys[h] = key;
            hashVals[h] = nextCode++;
          } else {
            emit(clearCode, codeSize);
            hashKeys.fill(-1);
            nextCode = eoiCode + 1;
            codeSize = lzwMin + 1;
            maxForSize = 1 << codeSize;
          }
          prefix = k;
        }
      }
      emit(prefix, codeSize);
      if (nextCode === maxForSize && codeSize < 12) {
        codeSize++;
      }
    }
    emit(eoiCode, codeSize);
    if (bitCount > 0) {
      sub[subLen++] = bitBuf & 0xff;
    }
    flushSub();
    writer.u8(0); // block terminator
  }

  // Creates an incremental GIF89a encoder from a palette sample so callers can
  // stream one RGBA frame at a time without retaining all raw frames in RAM:
  // `createEncoder({ width, height, sampleFrames, repeat = 0, maxColors = 255, useDelta = true })`
  // -> `{ addFrame(rgba, delayMs), finish() }`.
  function createEncoder({
    width, height, sampleFrames, repeat = 0, maxColors = 255, useDelta = true,
  }) {
    if (!Number.isInteger(width) || width <= 0 || width > 65535) {
      throw new RangeError(`invalid GIF width: ${width}`);
    }
    if (!Number.isInteger(height) || height <= 0 || height > 65535) {
      throw new RangeError(`invalid GIF height: ${height}`);
    }
    if (!Array.isArray(sampleFrames) || sampleFrames.length === 0) {
      throw new RangeError('GIF requires at least one sample frame');
    }
    const pixelCount = width * height;
    const expectedBytes = pixelCount * 4;
    for (let i = 0; i < sampleFrames.length; i++) {
      if (!sampleFrames[i] || sampleFrames[i].length !== expectedBytes) {
        throw new RangeError(`sample frame ${i} RGBA length mismatch`);
      }
    }

    const { palette, colorBits, transparentIndex, mapFrame } = quantize(
      sampleFrames,
      { maxColors, reserveTransparent: useDelta },
    );

    const out = new ByteWriter(Math.max(16384, pixelCount));
    // Header + Logical Screen Descriptor.
    out.ascii('GIF89a');
    out.u16(width);
    out.u16(height);
    out.u8(0x80 | ((colorBits - 1) << 4) | (colorBits - 1));
    out.u8(0); // background color index
    out.u8(0); // pixel aspect ratio
    out.bytes(palette);

    // NETSCAPE2.0 looping extension (0 = infinite loop, >0 = repeat count, <0 = play once).
    if (repeat >= 0) {
      out.u8(0x21);
      out.u8(0xff);
      out.u8(0x0b);
      out.ascii('NETSCAPE2.0');
      out.u8(0x03);
      out.u8(0x01);
      out.u16(repeat & 0xffff);
      out.u8(0x00);
    }

    const cur = new Uint8Array(pixelCount);
    const prev = new Uint8Array(pixelCount);
    const hashKeys = new Int32Array(HASH_SIZE);
    const hashVals = new Uint16Array(HASH_SIZE);
    let subBuf = null;
    let frameIndex = 0;
    let finished = false;

    const addFrame = (rgba, delayMs = 100) => {
      if (finished) throw new Error('GIF encoder already finished');
      if (!rgba || rgba.length !== expectedBytes) {
        throw new RangeError(`frame ${frameIndex} RGBA length mismatch`);
      }
      mapFrame(rgba, cur);
      const delayCs = Math.max(2, Math.min(65535, Math.round((delayMs || 100) / 10)));

      let left = 0;
      let top = 0;
      let fw = width;
      let fh = height;
      let pixels = cur;
      let hasTrans = false;

      if (frameIndex === 0 || transparentIndex < 0) {
        prev.set(cur);
      } else {
        // Compute dirty bounding box against the current canvas state.
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0, p = 0; y < height; y++) {
          for (let x = 0; x < width; x++, p++) {
            if (cur[p] !== prev[p]) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        hasTrans = true;
        if (maxX < minX) {
          // Identical frame: emit a 1x1 transparent patch to preserve frame count & timing.
          left = 0;
          top = 0;
          fw = 1;
          fh = 1;
          pixels = new Uint8Array([transparentIndex]);
        } else {
          left = minX;
          top = minY;
          fw = maxX - minX + 1;
          fh = maxY - minY + 1;
          const need = fw * fh;
          if (!subBuf || subBuf.length < need) subBuf = new Uint8Array(need);
          let q = 0;
          for (let y = minY; y <= maxY; y++) {
            let p = y * width + minX;
            for (let x = minX; x <= maxX; x++, p++, q++) {
              if (cur[p] === prev[p]) {
                subBuf[q] = transparentIndex;
              } else {
                subBuf[q] = cur[p];
                prev[p] = cur[p];
              }
            }
          }
          pixels = subBuf.subarray(0, need);
        }
      }

      // Graphic Control Extension: disposal=1 (keep canvas), optional transparent index.
      out.u8(0x21);
      out.u8(0xf9);
      out.u8(0x04);
      out.u8((1 << 2) | (hasTrans ? 1 : 0));
      out.u16(delayCs);
      out.u8(hasTrans ? transparentIndex : 0);
      out.u8(0x00);

      // Image Descriptor (no local color table, non-interlaced).
      out.u8(0x2c);
      out.u16(left);
      out.u16(top);
      out.u16(fw);
      out.u16(fh);
      out.u8(0x00);

      writeLzw(out, pixels, colorBits, hashKeys, hashVals);
      frameIndex++;
    };

    const finish = () => {
      if (finished) throw new Error('GIF encoder already finished');
      if (frameIndex === 0) throw new RangeError('GIF requires at least one frame');
      finished = true;
      out.u8(0x3b); // GIF trailer
      return out.finish();
    };

    return { addFrame, finish };
  }

  // Encodes an animated GIF89a from RGBA frames:
  // `{ width, height, frames: [{ rgba, delayMs }], repeat = 0, maxColors = 255 }` -> Uint8Array.
  function encode({ width, height, frames, repeat = 0, maxColors = 255 }) {
    if (!Array.isArray(frames) || frames.length === 0) {
      throw new RangeError('GIF requires at least one frame');
    }
    const enc = createEncoder({
      width,
      height,
      sampleFrames: frames.map((f) => f?.rgba),
      repeat,
      maxColors,
      useDelta: frames.length > 1,
    });
    for (let i = 0; i < frames.length; i++) {
      enc.addFrame(frames[i].rgba, frames[i].delayMs);
    }
    return enc.finish();
  }

  globalThis.SwarmGif = { createEncoder, encode, quantize };
})();
