import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentWhisperCppBodyLimit,
  VOICE_PCM_MAX_BYTES,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as WhisperCpp from "./WhisperCpp.ts";

const bodyLimit = Layer.succeed(EnvironmentWhisperCppBodyLimit, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"]) > VOICE_PCM_MAX_BYTES) {
      return yield* failEnvironmentInvalidRequest("invalid_audio");
    }
    return yield* effect.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(VOICE_PCM_MAX_BYTES)),
    );
  }),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "whisperCpp",
  Effect.fnUntraced(function* (handlers) {
    const whisperCpp = yield* WhisperCpp.WhisperCpp;
    return handlers
      .handle(
        "status",
        Effect.fn("environment.whisperCpp.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* whisperCpp.status;
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.whisperCpp.transcribe")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const text = yield* whisperCpp.transcribe(args.payload).pipe(
            Effect.catchTags({
              WhisperCppInvalidAudioError: () => failEnvironmentInvalidRequest("invalid_audio"),
              WhisperCppUnavailableError: () => failEnvironmentInvalidRequest("voice_unavailable"),
              WhisperCppTranscriptionError: (error) =>
                failEnvironmentInternal("internal_error", error),
            }),
          );
          return { text };
        }),
      );
  }),
).pipe(Layer.provide(bodyLimit));
