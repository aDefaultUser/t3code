// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - real HTTP boundary test.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentWhisperCppHttpApi,
  VOICE_PCM_MAX_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type * as NetAddress from "effect/net/NetAddress";

import * as VoiceHttp from "./http.ts";
import * as WhisperCpp from "./WhisperCpp.ts";

const sessionId = Schema.decodeSync(AuthSessionId)("voice-test");

const serve = (
  service: WhisperCpp.WhisperCpp["Service"],
  scopes: ReadonlyArray<AuthEnvironmentScope> = [AuthOrchestrationOperateScope],
) =>
  Effect.gen(function* () {
    const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
      effect.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, {
          sessionId,
          subject: "test",
          method: "bearer-access-token",
          scopes: new Set(scopes),
        }),
      ),
    );
    const routes = HttpApiBuilder.layer(
      HttpApi.make("environment").add(EnvironmentWhisperCppHttpApi),
    ).pipe(
      Layer.provide(VoiceHttp.layer),
      Layer.provide(auth),
      Layer.provide(Layer.succeed(WhisperCpp.WhisperCpp, service)),
    );
    yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
    const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
    const host = address._tag === "InetAddressV6" ? "[::1]" : "127.0.0.1";
    return `http://${host}:${address.port}/api/voice/whisper-cpp/transcribe`;
  });

const post = (url: string, body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>) =>
  Effect.promise(() =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    }),
  );

const service = (
  transcribe: WhisperCpp.WhisperCpp["Service"]["transcribe"],
): WhisperCpp.WhisperCpp["Service"] => ({
  status: Effect.succeed({ issue: null, language: "auto", binaryPath: "/bin/whisper-cli" }),
  transcribe,
});

const speech = new Uint8Array([1, 0, 2, 0]);

it.live("passes raw PCM through and returns the transcript", () =>
  Effect.gen(function* () {
    const received: Array<ReadonlyArray<number>> = [];
    const url = yield* serve(
      service((pcm) => {
        received.push([...pcm]);
        return Effect.succeed("hello");
      }),
    );
    const response = yield* post(url, speech);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(yield* Effect.promise(() => response.json()), { text: "hello" });
    assert.deepStrictEqual(received, [[1, 0, 2, 0]]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("refuses audio from a session that cannot operate the environment", () =>
  Effect.gen(function* () {
    let calls = 0;
    const url = yield* serve(
      service(() => {
        calls += 1;
        return Effect.succeed("unexpected");
      }),
      [],
    );
    assert.strictEqual((yield* post(url, speech)).status, 403);
    const status = yield* Effect.promise(() => fetch(new URL("status", url)));
    assert.strictEqual(status.status, 403);
    assert.strictEqual(calls, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("stops reading a body over the limit, declared or streamed", () =>
  Effect.gen(function* () {
    let calls = 0;
    const url = yield* serve(
      service(() => {
        calls += 1;
        return Effect.succeed("unexpected");
      }),
    );
    const declared = yield* post(url, new Uint8Array(VOICE_PCM_MAX_BYTES + 2));
    assert.strictEqual(declared.status, 400);
    assert.include(yield* Effect.promise(() => declared.text()), "invalid_audio");

    const streamed = yield* post(
      url,
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(VOICE_PCM_MAX_BYTES));
          controller.enqueue(new Uint8Array(2));
          controller.close();
        },
      }),
    );
    assert.strictEqual(streamed.status, 413);
    assert.strictEqual(calls, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.live("maps service errors to reasons a client can explain", () =>
  Effect.gen(function* () {
    const cases = [
      [new WhisperCpp.WhisperCppInvalidAudioError({ bytes: 3 }), 400, "invalid_audio"],
      [new WhisperCpp.WhisperCppUnavailableError({ issue: "disabled" }), 400, "voice_unavailable"],
      [
        new WhisperCpp.WhisperCppTranscriptionError({ exitCode: 3, stderr: "secret path" }),
        500,
        "internal_error",
      ],
    ] as const;
    for (const [error, expectedStatus, reason] of cases) {
      yield* Effect.gen(function* () {
        const url = yield* serve(service(() => Effect.fail(error)));
        const response = yield* post(url, speech);
        assert.strictEqual(response.status, expectedStatus);
        const body = yield* Effect.promise(() => response.text());
        assert.include(body, reason);
        assert.notInclude(body, "secret path");
      }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest));
    }
  }),
);
