import {deflateRawSync,inflateRawSync} from 'node:zlib';
import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from './framing.mjs';
const MAX_LINE = Math.ceil((MAX_FRAME_BYTES + 4) / 3) * 4 + 2;
export function encodeSshFrame(message) {
  const frame = encodeFrame(message);
  if (frame.length >= 4096) {
    const compressed = deflateRawSync(frame,{level:1});
    if (compressed.length + 2 < frame.length) return 'z:' + compressed.toString('base64') + '\n';
  }
  return frame.toString('base64') + '\n';
}
export class SshFrameDecoder {
  chunks = [];
  pendingBytes = 0;
  failed = false;
  get pending() { return this.pendingBytes > 0; }
  push(chunk, onMessage) {
    if (this.failed) throw new Error('SSH decoder failed');
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10,offset);
        const part = chunk.subarray(offset,end < 0 ? chunk.length : end);
        this.pendingBytes += part.length;
        if (this.pendingBytes > MAX_LINE + 1) throw Error('SSH frame too large');
        if (part.length) this.chunks.push(part);
        if (end < 0) break;
        let line = Buffer.concat(this.chunks,this.pendingBytes).toString('ascii').replace(/\r$/,'');
        this.chunks = []; this.pendingBytes = 0;
        const compressed = line.startsWith('z:');
        if (compressed) line = line.slice(2);
        if (!line.length || line.length % 4 || /[^A-Za-z0-9+/=]/.test(line)) throw new Error('Invalid SSH carrier');
        let data = Buffer.from(line, 'base64');
        if (data.toString('base64') !== line) throw Error('Invalid SSH carrier');
        if (compressed) data = inflateRawSync(data,{maxOutputLength:MAX_FRAME_BYTES+4});
        if (data.length < 4 || data.readUInt32LE(0) !== data.length - 4) throw new Error('Incomplete SSH frame');
        new FrameDecoder().push(data, onMessage);
        offset = end + 1;
      }
    } catch (error) { this.failed = true; this.chunks = []; this.pendingBytes = 0; throw error; }
  }
}
