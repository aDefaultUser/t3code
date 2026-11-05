import { VOICE_PCM_SAMPLE_RATE } from "@t3tools/contracts";

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

/**
 * The samples of a 16 kHz mono 16-bit WAV, or null for any other format.
 * Walks chunks because Apple's recorder pads the header with extra ones.
 */
export function pcmFromWav(wav: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (wav.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let hasExpectedFormat = false;
  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= wav.byteLength) {
      hasExpectedFormat =
        view.getUint16(body, true) === 1 &&
        view.getUint16(body + 2, true) === 1 &&
        view.getUint32(body + 4, true) === VOICE_PCM_SAMPLE_RATE &&
        view.getUint16(body + 14, true) === 16;
    }
    if (id === "data") {
      if (!hasExpectedFormat) return null;
      // A recorder that was not finalized leaves an unset or oversized data length.
      const end = Math.min(body + size, wav.byteLength);
      return wav.slice(body, end - ((end - body) % 2));
    }
    offset = body + size + (size % 2);
  }
  return null;
}
