import * as Schema from "effect/Schema";

/** Clients upload raw little-endian 16-bit mono PCM at this rate, which is what whisper.cpp expects. */
export const VOICE_PCM_SAMPLE_RATE = 16_000;

// Slightly over the five-minute recording limit so a late recorder stop does not lose the take.
export const VOICE_PCM_MAX_BYTES = VOICE_PCM_SAMPLE_RATE * 2 * 310;

export const EnvironmentVoiceIssue = Schema.Literals([
  "disabled",
  "binary-missing",
  "model-missing",
]);
export type EnvironmentVoiceIssue = typeof EnvironmentVoiceIssue.Type;

export const EnvironmentVoiceStatus = Schema.Struct({
  issue: Schema.NullOr(EnvironmentVoiceIssue),
  language: Schema.String,
  binaryPath: Schema.NullOr(Schema.String),
});
export type EnvironmentVoiceStatus = typeof EnvironmentVoiceStatus.Type;

export const EnvironmentVoiceTranscription = Schema.Struct({ text: Schema.String });
export type EnvironmentVoiceTranscription = typeof EnvironmentVoiceTranscription.Type;
