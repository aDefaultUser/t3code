// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import { VOICE_PCM_MAX_BYTES, VOICE_PCM_SAMPLE_RATE } from "@t3tools/contracts";
import type { EnvironmentVoiceIssue, EnvironmentVoiceStatus } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

const DEFAULT_BINARY_NAMES = ["whisper-cli", "whisper-cpp"];
// Generous for a five-minute recording on a CPU with a large model.
const TRANSCRIPTION_TIMEOUT = "15 minutes";
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const WAV_HEADER_BYTES = 44;
// About 0.6% of full scale: below any speech, above digital silence and a suppressed noise floor.
const SILENCE_PEAK = 200;
// The error line comes first; usage text follows it.
const STDERR_LOG_CHARS = 2_000;

export class WhisperCppInvalidAudioError extends Schema.TaggedError<WhisperCppInvalidAudioError>()(
  "WhisperCppInvalidAudioError",
  { bytes: Schema.Number },
) {
  override get message(): string {
    return "The recording is not valid 16-bit PCM audio of an accepted length.";
  }
}

export class WhisperCppUnavailableError extends Schema.TaggedError<WhisperCppUnavailableError>()(
  "WhisperCppUnavailableError",
  { issue: Schema.String },
) {
  override get message(): string {
    return `whisper.cpp is not ready on this environment (${this.issue}).`;
  }
}

export class WhisperCppTranscriptionError extends Schema.TaggedError<WhisperCppTranscriptionError>()(
  "WhisperCppTranscriptionError",
  {
    exitCode: Schema.NullOr(Schema.Number),
    stderr: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `whisper.cpp failed to transcribe (exit code ${this.exitCode ?? "unknown"}).`;
  }
}

export type WhisperCppError =
  | WhisperCppInvalidAudioError
  | WhisperCppUnavailableError
  | WhisperCppTranscriptionError;

export class WhisperCpp extends Context.Service<
  WhisperCpp,
  {
    readonly status: Effect.Effect<EnvironmentVoiceStatus>;
    readonly transcribe: (pcm: Uint8Array) => Effect.Effect<string, WhisperCppError>;
  }
>()("t3/voice/WhisperCpp") {}

/** Whisper's markers for audio without words; real speech in brackets is left alone. */
const NON_SPEECH_MARKER =
  /\[\s*(?:blank_audio|no_speech|silence|music|inaudible)\s*\]|\(\s*(?:silence|music|inaudible)\s*\)/gi;
// Output that is nothing but bracketed sounds, such as "(wind blowing)", has no speech in it.
const ONLY_BRACKETED_SOUNDS = /^(?:\s*(?:\[[^\]]*\]|\([^)]*\)))+\s*$/;

function cleanWhisperOutput(stdout: string): string {
  if (ONLY_BRACKETED_SOUNDS.test(stdout)) return "";
  return stdout.replace(NON_SPEECH_MARKER, " ").replace(/\s+/g, " ").trim();
}

/**
 * whisper-cli defaults to 4 threads. Measured on 16 cores and 32 logical CPUs, it gets faster up to
 * the physical core count and slower past it, so use half the logical CPUs and leave room for agents.
 */
export function whisperThreadCount(logicalCpus: number): number {
  return Math.max(Math.min(4, logicalCpus), Math.min(16, Math.floor(logicalCpus / 2)));
}

/** Whisper invents words such as "you" for silence, so it never sees a recording with no signal. */
function isSilent(pcm: Uint8Array): boolean {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    if (Math.abs(view.getInt16(offset, true)) >= SILENCE_PEAK) return false;
  }
  return true;
}

function wavFromPcm(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let index = 0; index < tag.length; index += 1) {
      view.setUint8(offset + index, tag.charCodeAt(index));
    }
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_PCM_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_PCM_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, WAV_HEADER_BYTES);
  return wav;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const transcriptionPermit = yield* Semaphore.make(1);

  const resolve = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    const { enabled, binaryPath, modelPath, language } = settings.whisperCpp;
    const home = yield* HostProcess.HomeDirectory;

    let resolvedBinary: string | null = null;
    for (const candidate of binaryPath === ""
      ? DEFAULT_BINARY_NAMES
      : [expandHomePath(binaryPath, home)]) {
      resolvedBinary = yield* resolveCommandPath(candidate);
      if (resolvedBinary !== null) break;
    }

    const expandedModel = expandHomePath(modelPath, home);
    const modelIsFile =
      expandedModel !== "" &&
      path.isAbsolute(expandedModel) &&
      (yield* fileSystem.stat(expandedModel).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      ));

    const issue: EnvironmentVoiceIssue | null = !enabled
      ? "disabled"
      : resolvedBinary === null
        ? "binary-missing"
        : !modelIsFile
          ? "model-missing"
          : null;
    return { issue, binary: resolvedBinary, model: expandedModel, language };
  }).pipe(Effect.provide(hostServices));

  const status: WhisperCpp["Service"]["status"] = resolve.pipe(
    Effect.map(({ issue, language, binary }) => ({ issue, language, binaryPath: binary })),
  );

  const runTranscription = Effect.fn("WhisperCpp.runTranscription")(function* (pcm: Uint8Array) {
    const { issue, binary, model, language } = yield* resolve;
    if (issue !== null || binary === null) {
      return yield* new WhisperCppUnavailableError({ issue: issue ?? "binary-missing" });
    }
    if (isSilent(pcm)) return "";
    const failure = (cause: unknown) =>
      new WhisperCppTranscriptionError({ exitCode: null, stderr: "", cause });
    // The temporary directory is private to this user and removed with its scope, including on cancel.
    const directory = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-whisper-" })
      .pipe(Effect.mapError(failure));
    const wavPath = path.join(directory, "dictation.wav");
    yield* fileSystem.writeFile(wavPath, wavFromPcm(pcm)).pipe(Effect.mapError(failure));
    const result = yield* processRunner
      .run({
        command: binary,
        args: [
          "-m",
          model,
          "-f",
          wavPath,
          "-l",
          language,
          "-t",
          String(whisperThreadCount(NodeOS.availableParallelism())),
          "-nt",
          "-np",
        ],
        timeout: TRANSCRIPTION_TIMEOUT,
        maxOutputBytes: MAX_TRANSCRIPT_BYTES,
        outputMode: "truncate",
      })
      .pipe(Effect.mapError(failure));
    const text = cleanWhisperOutput(result.stdout);
    // whisper-cli exits 0 after printing usage for options it rejects, such as an unknown language.
    if (result.code !== 0 || (text === "" && result.stderr.includes("error:"))) {
      return yield* new WhisperCppTranscriptionError({
        exitCode: result.code === null ? null : Number(result.code),
        stderr: result.stderr.slice(0, STDERR_LOG_CHARS),
      });
    }
    return text;
  }, Effect.scoped);

  const transcribe: WhisperCpp["Service"]["transcribe"] = Effect.fn("WhisperCpp.transcribe")(
    function* (pcm) {
      if (
        pcm.byteLength === 0 ||
        pcm.byteLength % 2 !== 0 ||
        pcm.byteLength > VOICE_PCM_MAX_BYTES
      ) {
        return yield* new WhisperCppInvalidAudioError({ bytes: pcm.byteLength });
      }
      // One at a time, because whisper saturates the CPU it gets. A second device waits: rejecting
      // it after the upload would make its user speak the whole recording again.
      return yield* runTranscription(pcm).pipe(transcriptionPermit.withPermits(1));
    },
  );

  return WhisperCpp.of({ status, transcribe });
});

export const layer = Layer.effect(WhisperCpp, make);
