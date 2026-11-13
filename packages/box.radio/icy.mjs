/** Icecast 间隔元数据剥除：只丢掉 meta 块，不解析标题。 */

/** MP3 帧同步 0xFFE / AAC ADTS 0xFFF */
export function findAudioSync(buf) {
  const u8 = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  for (let i = 0; i < u8.length - 1; i++) {
    if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) return i;
  }
  return -1;
}

export class SyncSkipper {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.synced = false;
  }

  /**
   * @param {Uint8Array} piece
   * @param {(audio: Uint8Array) => void} onAudio
   */
  push(piece, onAudio) {
    if (!piece?.length) return;
    if (this.synced) {
      onAudio(piece);
      return;
    }
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, Buffer.from(piece)])
      : Buffer.from(piece);
    const off = findAudioSync(this.pending);
    if (off < 0) {
      if (this.pending.length > 64 * 1024) {
        this.pending = Buffer.from(this.pending.subarray(this.pending.length - 2048));
      }
      return;
    }
    this.synced = true;
    const aligned = this.pending.subarray(off);
    this.pending = Buffer.alloc(0);
    if (aligned.length) onAudio(aligned);
  }
}

export class IcyStripper {
  /**
   * @param {number} metaint
   */
  constructor(metaint) {
    const n = Number(metaint);
    this.metaint = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    this.mode = this.metaint ? 'audio' : 'pass';
    this.need = this.metaint || 0;
  }

  /**
   * @param {Uint8Array} buf
   * @param {(audio: Uint8Array) => void} onAudio
   */
  push(buf, onAudio) {
    if (!buf?.length) return;
    if (this.mode === 'pass') {
      onAudio(buf);
      return;
    }
    let offset = 0;
    while (offset < buf.length) {
      if (this.mode === 'audio') {
        const take = Math.min(this.need, buf.length - offset);
        if (take > 0) onAudio(buf.subarray(offset, offset + take));
        offset += take;
        this.need -= take;
        if (this.need === 0) {
          this.mode = 'len';
          this.need = 1;
        }
      } else if (this.mode === 'len') {
        const metaBytes = buf[offset] * 16;
        offset += 1;
        if (metaBytes === 0) {
          this.mode = 'audio';
          this.need = this.metaint;
        } else {
          this.mode = 'meta';
          this.need = metaBytes;
        }
      } else {
        const take = Math.min(this.need, buf.length - offset);
        offset += take;
        this.need -= take;
        if (this.need === 0) {
          this.mode = 'audio';
          this.need = this.metaint;
        }
      }
    }
  }
}

export class ByteChunker {
  /** @param {number} size */
  /**
   * @param {number} size
   * @param {number} [firstSize]
   */
  constructor(size, firstSize = size) {
    this.size = size;
    this.firstSize = firstSize > 0 && firstSize < size ? firstSize : size;
    this.primed = this.firstSize === this.size;
    this.buf = Buffer.alloc(0);
  }

  /**
   * @param {Uint8Array} piece
   * @param {(chunk: Buffer) => void} onChunk
   */
  push(piece, onChunk) {
    this.buf = this.buf.length
      ? Buffer.concat([this.buf, Buffer.from(piece)])
      : Buffer.from(piece);
    for (;;) {
      const need = this.primed ? this.size : this.firstSize;
      if (this.buf.length < need) break;
      onChunk(Buffer.from(this.buf.subarray(0, need)));
      this.buf = Buffer.from(this.buf.subarray(need));
      this.primed = true;
    }
  }

  /** @param {(chunk: Buffer) => void} onChunk */
  flush(onChunk) {
    if (this.buf.length) onChunk(this.buf);
    this.buf = Buffer.alloc(0);
  }
}
