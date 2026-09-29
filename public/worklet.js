// Mic capture: forwards mono Float32 PCM at the context's native rate in ~4096-frame batches,
// plus the batch RMS for the level meter.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") this.flush();
    };
  }
  flush() {
    if (!this.n) return;
    const out = this.buf.slice(0, this.n);
    let s = 0;
    for (let i = 0; i < out.length; i++) s += out[i] * out[i];
    this.port.postMessage({ pcm: out, rms: Math.sqrt(s / out.length) }, [out.buffer]);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor("capture", Capture);
