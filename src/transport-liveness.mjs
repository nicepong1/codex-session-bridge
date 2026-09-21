// Silent connections fail after 15 seconds. Active bytes extend that deadline,
// but an unfinished frame cannot keep a peer alive indefinitely.
export class TransportLiveness {
  constructor(now = Date.now()) { this.lastData = now; this.frameStarted = null; }
  received(now,pending,completed) {
    this.lastData = now;
    if (!pending) this.frameStarted = null;
    else if (completed || this.frameStarted === null) this.frameStarted = now;
  }
  expired(now) { return now - this.lastData > 15000 || (this.frameStarted !== null && now - this.frameStarted > 120000); }
}
