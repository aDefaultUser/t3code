import {
  encodePcm16,
  throwIfVoiceTranscriptionAborted,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "@t3tools/client-runtime/voice-input";
import { VOICE_PCM_SAMPLE_RATE } from "@t3tools/contracts";

export function browserSupportsDictation(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

const stopTracks = (stream: MediaStream) => {
  for (const track of stream.getTracks()) track.stop();
};

/** Holding the stream here would leak a live microphone if the user cancels during the prompt. */
export async function requestMicrophonePermission() {
  const known = await navigator.permissions
    ?.query({ name: "microphone" as PermissionName })
    .then((status) => status.state)
    .catch(() => null);
  if (known === "granted") return { granted: true, canAskAgain: true };
  // Only getUserMedia is authoritative: Electron's check and request handlers can disagree.
  try {
    stopTracks(await navigator.mediaDevices.getUserMedia({ audio: true }));
    return { granted: true, canAskAgain: true };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      return { granted: false, canAskAgain: false };
    }
    throw error;
  }
}

/** decodeAudioData resamples to its context's rate, so no render pass is needed. */
async function decodeRecordingToPcm(blob: Blob) {
  if (blob.size === 0) return new Uint8Array(new ArrayBuffer(0));
  const context = new OfflineAudioContext(1, 1, VOICE_PCM_SAMPLE_RATE);
  const audio = await context.decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
    audio.getChannelData(index),
  );
  return encodePcm16(channels);
}

export function createBrowserVoiceRecorder(onStatus: (status: VoiceRecorderStatus) => void) {
  const recordings = new Map<string, Blob>();
  let nextRecordingId = 0;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let uri: string | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping: Promise<void> | null = null;

  const releaseStream = () => {
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
    if (stream) stopTracks(stream);
    stream = null;
    recorder = null;
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    const active = recorder;
    if (!active || active.state === "inactive") {
      releaseStream();
      return Promise.resolve();
    }
    stopping = new Promise<void>((resolve) => {
      active.addEventListener(
        "stop",
        () => {
          releaseStream();
          stopping = null;
          resolve();
        },
        { once: true },
      );
    });
    active.stop();
    return stopping;
  };

  const voiceRecorder: VoiceRecorder = {
    get uri() {
      return uri;
    },
    async prepareToRecordAsync(signal) {
      // Named before recording starts so a cancel can still delete what the stop event produces.
      const recordingUri = `recording:${++nextRecordingId}`;
      uri = recordingUri;
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (signal?.aborted) stopTracks(acquired);
      if (signal) throwIfVoiceTranscriptionAborted(signal);
      stream = acquired;
      const chunks: Blob[] = [];
      const created = new MediaRecorder(acquired);
      created.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      created.addEventListener("stop", () => {
        // An error can discard the recording before this event arrives.
        if (uri === recordingUri) {
          recordings.set(recordingUri, new Blob(chunks, { type: created.mimeType }));
        }
        // The browser ends the recording itself when the microphone goes away; keep what was said.
        if (!stopping && recorder === created) {
          releaseStream();
          onStatus({ isFinished: true, hasError: false, error: null, url: uri });
        }
      });
      created.addEventListener("error", () => {
        onStatus({
          isFinished: false,
          hasError: true,
          error: "The microphone stopped unexpectedly.",
          url: null,
        });
      });
      recorder = created;
    },
    record({ forDuration }) {
      if (!recorder) throw new Error("Voice recorder is not prepared.");
      recorder.start();
      limitTimer = setTimeout(() => {
        void stop().then(() => {
          onStatus({ isFinished: true, hasError: false, error: null, url: uri });
        });
      }, forDuration * 1_000);
    },
    stop,
  };

  return {
    recorder: voiceRecorder,
    readPcm: async (recordingUri: string) => {
      const blob = recordings.get(recordingUri);
      if (!blob) throw new Error("The recording is no longer available.");
      return decodeRecordingToPcm(blob);
    },
    deleteRecording: (recordingUri: string) => {
      recordings.delete(recordingUri);
      if (uri === recordingUri) uri = null;
    },
  };
}
