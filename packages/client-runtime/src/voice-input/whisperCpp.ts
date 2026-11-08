import type { EnvironmentVoiceIssue } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "./transcription.ts";

const STATUS_TIMEOUT_MS = 10_000;
// Outlasts the server's own limit so its error reaches the client instead of a client timeout.
const TRANSCRIBE_TIMEOUT_MS = 16 * 60_000;

export const getWhisperCppStatus = Effect.fn("clientRuntime.voiceInput.whisperCppStatus")(
  function* (prepared: PreparedConnection) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      group: "whisperCpp",
      prepared,
      signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
      ),
      method: "GET",
      url: (urls) => urls.status(),
      timeoutMs: STATUS_TIMEOUT_MS,
      request: ({ client, headers }) => client.status({ headers }),
    });
  },
);

const transcribeWhisperCppPcm = Effect.fn("clientRuntime.voiceInput.whisperCppTranscribe")(
  function* (prepared: PreparedConnection, pcm: Uint8Array<ArrayBuffer>) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      group: "whisperCpp",
      prepared,
      signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
      remoteAuthorization: yield* Effect.serviceOption(
        RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
      ),
      method: "POST",
      url: (urls) => urls.transcribe(),
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      request: ({ client, headers }) => client.transcribe({ headers, payload: pcm }),
    });
  },
);

export function voiceIssueMessage(issue: EnvironmentVoiceIssue): string {
  switch (issue) {
    case "disabled":
      return "whisper.cpp dictation is turned off on this environment.";
    case "binary-missing":
      return "whisper.cpp was not found on this environment. Install it or set its path in Settings → whisper.cpp.";
    case "model-missing":
      return "The whisper.cpp model file was not found on this environment. Check its path in Settings → whisper.cpp.";
  }
}

function environmentFailureMessage(error: {
  readonly _tag: string;
  readonly reason?: unknown;
  readonly status?: unknown;
}) {
  // Cloudflare's answer when the origin sends nothing for about two minutes.
  if (error.status === 524) {
    return "T3 Connect stopped waiting for whisper.cpp. Use a smaller model or a shorter recording.";
  }
  switch (error._tag) {
    case "EnvironmentScopeRequiredError":
      return "This connection is not allowed to dictate on this environment.";
    case "RemoteEnvironmentAuthTimeoutError":
      return "whisper.cpp took too long to answer.";
    case "RemoteEnvironmentAuthFetchError":
      return "Could not reach this environment to transcribe the recording.";
  }
  switch (error.reason) {
    case "voice_unavailable":
      return "whisper.cpp is not set up on this environment. Check Settings → whisper.cpp.";
    case "invalid_audio":
      return "The environment could not accept this recording.";
  }
  return "whisper.cpp could not transcribe this recording. The environment's logs have the details.";
}

const toTranscriptionError =
  (code: "preparation-failed" | "transcription-failed") =>
  (error: Parameters<typeof environmentFailureMessage>[0]) =>
    new VoiceTranscriptionError({ code, message: environmentFailureMessage(error), cause: error });

// Requiring the authorization service here makes a runtime without it a type error. It is only
// read optionally below, so otherwise relay requests would fail at runtime on every DPoP connection.
type VoiceRequestServices =
  | HttpClient.HttpClient
  | RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

export type VoiceRequestRunner = <A, E>(
  effect: Effect.Effect<A, E, VoiceRequestServices>,
  options: VoiceTranscriptionOptions,
) => Promise<A>;

/** Runs requests on the application's connection runtime, cancelling through the abort signal. */
export function createVoiceRequestRunner<R extends VoiceRequestServices, ER>(
  registry: AtomRegistry.AtomRegistry,
  runtime: Atom.AtomRuntime<R, ER>,
): VoiceRequestRunner {
  return (effect, options) => {
    const context = registry.get(runtime);
    if (!AsyncResult.isSuccess(context)) {
      return Promise.reject(
        new VoiceTranscriptionError({
          code: "unavailable",
          message: "The connection is still starting.",
        }),
      );
    }
    return Effect.runPromiseWith(context.value as Context.Context<VoiceRequestServices>)(
      effect,
      options,
    );
  };
}

export function createWhisperCppTranscriber(input: {
  readonly getPrepared: () => PreparedConnection | null;
  readonly run: VoiceRequestRunner;
  readonly readPcm: (
    uri: string,
    options: VoiceTranscriptionOptions,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  readonly deviceLocale: () => string;
}): VoiceTranscriber {
  const connection = () => {
    const prepared = input.getPrepared();
    if (prepared) return prepared;
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: "This environment is not connected.",
    });
  };

  return {
    prepare: async (options) => {
      throwIfVoiceTranscriptionAborted(options.signal);
      const status = await input.run(
        getWhisperCppStatus(connection()).pipe(
          Effect.mapError(toTranscriptionError("preparation-failed")),
        ),
        options,
      );
      throwIfVoiceTranscriptionAborted(options.signal);
      if (status.issue !== null) {
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message: voiceIssueMessage(status.issue),
        });
      }
      return {
        locale: status.language === "auto" ? input.deviceLocale() : status.language,
        transcribe: async (uri, transcribeOptions) => {
          const pcm = await input.readPcm(uri, transcribeOptions);
          throwIfVoiceTranscriptionAborted(transcribeOptions.signal);
          if (pcm.byteLength === 0) return "";
          const { text } = await input.run(
            transcribeWhisperCppPcm(connection(), pcm).pipe(
              Effect.mapError(toTranscriptionError("transcription-failed")),
            ),
            transcribeOptions,
          );
          throwIfVoiceTranscriptionAborted(transcribeOptions.signal);
          return text;
        },
      };
    },
  };
}
