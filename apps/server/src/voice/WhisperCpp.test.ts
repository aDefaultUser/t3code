import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { VOICE_PCM_MAX_BYTES } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CommandResolutionCache } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WhisperCpp from "./WhisperCpp.ts";

const processOutput = (
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: 0 as ChildProcessSpawner.ExitCode,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "whisper-test-" });
  const installBinary = Effect.fn("installBinary")(function* (name: string) {
    const binary = path.join(directory, name);
    yield* fileSystem.writeFileString(binary, "#!/bin/sh\n");
    yield* fileSystem.chmod(binary, 0o755);
    return binary;
  });
  const model = path.join(directory, "ggml-base.en.bin");
  yield* fileSystem.writeFileString(model, "model");
  return { directory, installBinary, model };
});

const withService = <A, E, R>(
  settings: Partial<{
    enabled: boolean;
    binaryPath: string;
    modelPath: string;
    language: string;
  }>,
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  directory: string,
  effect: Effect.Effect<A, E, R | WhisperCpp.WhisperCpp>,
) =>
  effect.pipe(
    Effect.provide(
      WhisperCpp.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ whisperCpp: settings }),
            Layer.succeed(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run })),
          ),
        ),
      ),
    ),
    Effect.provideService(HostProcess.Environment, { PATH: directory }),
    Effect.provideService(CommandResolutionCache, new Map()),
  );

const unusedRun: ProcessRunner.ProcessRunner["Service"]["run"] = () => Effect.die("not used");
const speech = new Uint8Array([1, 0, 2, 0]);

describe("WhisperCpp", () => {
  it.effect("reports what stands between the settings and a working setup", () =>
    Effect.gen(function* () {
      const { directory, installBinary, model } = yield* fixture;
      const status = (settings: Parameters<typeof withService>[0]) =>
        withService(
          settings,
          unusedRun,
          directory,
          Effect.flatMap(WhisperCpp.WhisperCpp, (service) => service.status),
        );

      assert.strictEqual((yield* status({ enabled: false })).issue, "disabled");
      assert.strictEqual((yield* status({ enabled: true })).issue, "binary-missing");
      assert.strictEqual(
        (yield* status({ enabled: true, binaryPath: `${directory}/absent` })).issue,
        "binary-missing",
      );

      const fallback = yield* installBinary("whisper-cpp");
      assert.strictEqual((yield* status({ enabled: true })).issue, "model-missing");
      assert.strictEqual(
        (yield* status({ enabled: true, modelPath: "relative/model.bin" })).issue,
        "model-missing",
      );
      assert.strictEqual(
        (yield* status({ enabled: true, modelPath: directory })).issue,
        "model-missing",
      );
      assert.deepStrictEqual(yield* status({ enabled: true, modelPath: model, language: "fr" }), {
        issue: null,
        language: "fr",
        binaryPath: fallback,
      });

      const preferred = yield* installBinary("whisper-cli");
      assert.strictEqual(
        (yield* status({ enabled: true, modelPath: model })).binaryPath,
        preferred,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("transcribes through a private WAV file that does not outlive the call", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { directory, installBinary, model } = yield* fixture;
      const binary = yield* installBinary("whisper-cli");
      const calls: Array<{ command: string; args: ReadonlyArray<string>; wav: Uint8Array }> = [];
      const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
        Effect.gen(function* () {
          const wavPath = input.args[input.args.indexOf("-f") + 1]!;
          calls.push({
            command: input.command,
            args: input.args,
            wav: yield* fileSystem.readFile(wavPath).pipe(Effect.orDie),
          });
          return processOutput({ stdout: " Add a test.\n [BLANK_AUDIO]\n For arr[0]. \n\n" });
        });

      const text = yield* withService(
        { enabled: true, modelPath: model, language: "en" },
        run,
        directory,
        Effect.flatMap(WhisperCpp.WhisperCpp, (service) => service.transcribe(speech)),
      );

      assert.strictEqual(text, "Add a test. For arr[0].");
      const call = calls[0]!;
      assert.strictEqual(call.command, binary);
      const wavPath = call.args[call.args.indexOf("-f") + 1]!;
      assert.deepStrictEqual(call.args, ["-m", model, "-f", wavPath, "-l", "en", "-nt", "-np"]);
      assert.isFalse(yield* fileSystem.exists(wavPath));

      const view = new DataView(call.wav.buffer, call.wav.byteOffset, call.wav.byteLength);
      assert.strictEqual(new TextDecoder().decode(call.wav.slice(0, 4)), "RIFF");
      assert.strictEqual(view.getUint32(4, true), 36 + speech.byteLength);
      assert.strictEqual(view.getUint16(22, true), 1, "mono");
      assert.strictEqual(view.getUint32(24, true), 16_000, "sample rate");
      assert.strictEqual(view.getUint16(34, true), 16, "bit depth");
      assert.strictEqual(view.getUint32(40, true), speech.byteLength);
      assert.deepStrictEqual(Array.from(call.wav.subarray(44)), Array.from(speech));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects audio that is not whole samples of an accepted length", () =>
    Effect.gen(function* () {
      for (const bytes of [0, 3, VOICE_PCM_MAX_BYTES + 2]) {
        const error = yield* withService(
          { enabled: true },
          unusedRun,
          "/nonexistent",
          Effect.flatMap(WhisperCpp.WhisperCpp, (service) =>
            service.transcribe(new Uint8Array(bytes)),
          ),
        ).pipe(Effect.flip);
        assert.strictEqual(error._tag, "WhisperCppInvalidAudioError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not start whisper when the setup is incomplete", () =>
    Effect.gen(function* () {
      const error = yield* withService(
        { enabled: false },
        unusedRun,
        "/nonexistent",
        Effect.flatMap(WhisperCpp.WhisperCpp, (service) => service.transcribe(speech)),
      ).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WhisperCppUnavailableError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a failed exit and an exit 0 usage error as failures, but silence as text", () =>
    Effect.gen(function* () {
      const { directory, installBinary, model } = yield* fixture;
      yield* installBinary("whisper-cli");
      const transcribeWith = (output: ProcessRunner.ProcessRunOutput) =>
        withService(
          { enabled: true, modelPath: model },
          () => Effect.succeed(output),
          directory,
          Effect.flatMap(WhisperCpp.WhisperCpp, (service) => service.transcribe(speech)),
        );

      const crashed = yield* transcribeWith(
        processOutput({
          code: 3 as ChildProcessSpawner.ExitCode,
          stdout: "partial",
          stderr: "error: failed to initialize whisper context",
        }),
      ).pipe(Effect.flip);
      assert.strictEqual(crashed._tag, "WhisperCppTranscriptionError");

      // whisper-cli prints the error, then several KB of usage, then exits 0.
      const usage = yield* transcribeWith(
        processOutput({ stderr: `error: unknown language 'xx'\n${"usage: ...\n".repeat(800)}` }),
      ).pipe(Effect.flip);
      assert.strictEqual(usage._tag, "WhisperCppTranscriptionError");
      assert.isTrue(
        usage._tag === "WhisperCppTranscriptionError" && usage.stderr.startsWith("error:"),
      );

      for (const silent of [
        " [BLANK_AUDIO]\n",
        " (wind blowing)\n",
        " [MUSIC PLAYING] [ Silence ]\n",
      ]) {
        assert.strictEqual(yield* transcribeWith(processOutput({ stdout: silent })), "");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("queues a second recording, and cancel frees the slot and the audio", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { directory, installBinary, model } = yield* fixture;
      yield* installBinary("whisper-cli");
      const started = yield* Deferred.make<string>();
      let calls = 0;
      const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
        calls += 1;
        return calls === 1
          ? Deferred.succeed(started, input.args[input.args.indexOf("-f") + 1]!).pipe(
              Effect.andThen(Effect.never),
            )
          : Effect.succeed(processOutput({ stdout: "the second recording" }));
      };

      yield* withService(
        { enabled: true, modelPath: model },
        run,
        directory,
        Effect.gen(function* () {
          const service = yield* WhisperCpp.WhisperCpp;
          const first = yield* Effect.forkChild(service.transcribe(speech));
          const wavPath = yield* Deferred.await(started);
          assert.isTrue(yield* fileSystem.exists(wavPath));

          const second = yield* Effect.forkChild(service.transcribe(speech));
          yield* Effect.yieldNow;
          assert.strictEqual(calls, 1, "the second recording waits for the first");

          yield* Fiber.interrupt(first);
          assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(first)));
          assert.isFalse(yield* fileSystem.exists(wavPath));

          assert.strictEqual(yield* Fiber.join(second), "the second recording");
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
