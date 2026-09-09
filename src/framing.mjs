export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (!body.length || body.length > MAX_FRAME_BYTES) throw new Error('Frame too large');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

// Handle fragmented headers, split UTF-8 characters, and coalesced frames.
export class FrameDecoder {
  #header = Buffer.alloc(4);
  #headerUsed = 0;
  #body = null;
  #bodyUsed = 0;
  #failed = false;

  push(chunk, onMessage) {
    if (this.#failed) throw new Error('Decoder has failed');
    let offset = 0;
    try {
      while (offset < chunk.length) {
        if (!this.#body) {
          const count = Math.min(4 - this.#headerUsed, chunk.length - offset);
          chunk.copy(this.#header, this.#headerUsed, offset, offset + count);
          offset += count;
          this.#headerUsed += count;
          if (this.#headerUsed !== 4) continue;
          const length = this.#header.readUInt32LE();
          if (!length || length > MAX_FRAME_BYTES) throw new Error('Invalid frame length');
          this.#body = Buffer.alloc(length);
          this.#headerUsed = 0;
        }
        const count = Math.min(this.#body.length - this.#bodyUsed, chunk.length - offset);
        chunk.copy(this.#body, this.#bodyUsed, offset, offset + count);
        offset += count;
        this.#bodyUsed += count;
        if (this.#bodyUsed === this.#body.length) {
          const body = this.#body;
          this.#body = null;
          this.#bodyUsed = 0;
          onMessage(JSON.parse(body.toString('utf8')));
        }
      }
    } catch (error) {
      this.#failed = true;
      this.#body = null;
      throw error;
    }
  }
}
