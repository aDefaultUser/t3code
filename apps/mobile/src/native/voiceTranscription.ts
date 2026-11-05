import {
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

export async function getLocalVoiceTranscriber(): Promise<VoiceTranscriber | null> {
  return null;
}

export async function readRecordingPcm(): Promise<Uint8Array<ArrayBuffer>> {
  throw new VoiceTranscriptionError("unavailable", "Recordings cannot be read on this platform.");
}
