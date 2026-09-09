import { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from './framing.mjs';
const MAX_LINE = Math.ceil((MAX_FRAME_BYTES + 4) / 3) * 4;
export const encodeSshFrame = message => encodeFrame(message).toString('base64') + '\n';
export class SshFrameDecoder {
  pending = '';
  failed = false;
  push(chunk, onMessage) {
    if (this.failed) throw new Error('SSH decoder failed');
    try {
      this.pending += chunk.toString('ascii');
      let end;
      while ((end = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, end).replace(/\r$/, '');
        this.pending = this.pending.slice(end + 1);
        if (!line.length || line.length > MAX_LINE || line.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(line)) throw new Error('Invalid SSH carrier');
        const data = Buffer.from(line, 'base64');
        if (data.length < 4 || data.readUInt32LE(0) !== data.length - 4) throw new Error('Incomplete SSH frame');
        new FrameDecoder().push(data, onMessage);
      }
      if (this.pending.length > MAX_LINE + 1) throw new Error('SSH frame too large');
    } catch (error) { this.failed = true; this.pending = ''; throw error; }
  }
}
