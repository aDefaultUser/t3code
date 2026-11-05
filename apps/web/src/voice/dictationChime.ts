export type DictationChime = "on" | "off";

const C5 = 523.25;
const E5 = 659.25;
const NOTES: Readonly<Record<DictationChime, readonly [number, number]>> = {
  on: [C5, E5],
  off: [E5, C5],
};
const NOTE_SECONDS = 0.16;
const NOTE_SPACING_SECONDS = 0.09;
const ATTACK_SECONDS = 0.012;
const SILENT_GAIN = 0.0001;
const PEAK_GAIN = 0.06;
const CHIME_MILLISECONDS = (NOTE_SPACING_SECONDS + NOTE_SECONDS) * 1_000;

function scheduleDictationChime(context: BaseAudioContext, chime: DictationChime): void {
  NOTES[chime].forEach((frequency, index) => {
    const startsAt = context.currentTime + index * NOTE_SPACING_SECONDS;
    const endsAt = startsAt + NOTE_SECONDS;
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    const gain = context.createGain();
    gain.gain.setValueAtTime(SILENT_GAIN, startsAt);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, startsAt + ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(SILENT_GAIN, endsAt);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(startsAt);
    oscillator.stop(endsAt);
  });
}

/** Settles on a timer, because a suspended context never finishes and dictation must not hang on a sound. */
export function playDictationChime(chime: DictationChime): Promise<void> {
  return new Promise((resolve) => {
    let context: AudioContext | null = null;
    try {
      context = new AudioContext();
      void context.resume().catch(() => {});
      scheduleDictationChime(context, chime);
    } catch {
      // A missing sound must never stop the dictation it announces.
    }
    setTimeout(() => {
      void context?.close().catch(() => {});
      resolve();
    }, CHIME_MILLISECONDS);
  });
}
