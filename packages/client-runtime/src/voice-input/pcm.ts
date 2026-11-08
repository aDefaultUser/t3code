/** Averages channels into the little-endian 16-bit mono PCM environments accept. */
export function encodePcm16(channels: ReadonlyArray<Float32Array>): Uint8Array<ArrayBuffer> {
  const frames = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(new ArrayBuffer(frames * 2));
  const view = new DataView(bytes.buffer);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[frame] ?? 0;
    const sample = Math.max(-1, Math.min(1, sum / channels.length));
    view.setInt16(frame * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}
