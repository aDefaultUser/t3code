import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { createEnvironmentVoiceTranscriber, createVoiceRequestRunner } from "./environment.ts";
import { encodePcm16, pcmFromWav } from "./pcm.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: "environment-voice" as never,
  label: "Voice",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: { _tag: "Bearer", token: "token" },
  target: TARGET,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const READY = { issue: null, language: "auto", binaryPath: "/usr/bin/whisper-cli" };
const PCM = new Uint8Array([1, 0, 2, 0]);

const layerServices = (fetchFn: typeof globalThis.fetch) =>
  Layer.mergeAll(
    layerRemoteHttpClient(fetchFn),
    Layer.mock(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization)({
      authorizeDpopHttp: () =>
        Effect.succeed({
          httpBaseUrl: "https://relay.example.test",
          httpAuthorization: { _tag: "Dpop", accessToken: "relay-token", expiresAtEpochMs: 1 },
        } as never),
    }),
    Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, {
      createProof: () => Effect.succeed("proof"),
    } as never),
  );

// The real runner on an atom runtime, because a runtime without these services is what breaks T3 Connect.
const setup = (
  fetchFn: typeof globalThis.fetch,
  pcm: Uint8Array<ArrayBuffer> = PCM,
  prepared: PreparedConnection = PREPARED,
) => {
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(layerServices(fetchFn));
  registry.mount(runtime);
  return createEnvironmentVoiceTranscriber({
    getPrepared: () => prepared,
    run: createVoiceRequestRunner(registry, runtime),
    readPcm: async () => pcm,
    deviceLocale: () => "en-GB",
  });
};

const options = () => ({ signal: new AbortController().signal });

describe("createEnvironmentVoiceTranscriber", () => {
  it("uploads the recording as raw PCM with this client's credentials", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: Uint8Array }> = [];
    const fetchFn = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "GET") return json(READY);
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return json({ text: "Add a test." });
    });
    const prepared = await setup(fetchFn).prepare(options());
    expect(prepared.locale).toBe("en-GB");
    expect(await prepared.transcribe("recording:1", options())).toBe("Add a test.");
    expect(requests).toEqual([
      {
        url: "https://environment.example.test/api/voice/transcribe",
        authorization: "Bearer token",
        body: PCM,
      },
    ]);
  });

  it("authorizes with DPoP on a relay connection", async () => {
    const seen: Array<{ authorization: string | null; dpop: string | null; url: string }> = [];
    const fetchFn: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        authorization: request.headers.get("authorization"),
        dpop: request.headers.get("dpop"),
        url: request.url,
      });
      return json(READY);
    };
    await setup(fetchFn, PCM, {
      ...PREPARED,
      httpAuthorization: { _tag: "Dpop", accessToken: "stale", expiresAtEpochMs: 1 },
    }).prepare(options());
    expect(seen).toEqual([
      {
        authorization: "DPoP relay-token",
        dpop: "proof",
        url: "https://environment.example.test/api/voice/status",
      },
    ]);
  });

  it("explains a tunnel that stopped waiting for a long transcription", async () => {
    const fetchFn: typeof globalThis.fetch = async (input, init) =>
      new Request(input, init).method === "GET" ? json(READY) : new Response("", { status: 524 });
    const prepared = await setup(fetchFn).prepare(options());
    await expect(prepared.transcribe("recording:1", options())).rejects.toMatchObject({
      message: expect.stringMatching(/smaller model/),
    });
  });

  it("uses the environment's language when it is pinned", async () => {
    const prepared = await setup(async () => json({ ...READY, language: "fr" })).prepare(options());
    expect(prepared.locale).toBe("fr");
  });

  it.each([
    ["disabled", /turned off/],
    ["binary-missing", /was not found/],
    ["model-missing", /model file was not found/],
  ] as const)("refuses to record when the environment reports %s", async (issue, message) => {
    await expect(
      setup(async () => json({ ...READY, issue })).prepare(options()),
    ).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(message) });
  });

  it.each([
    ["voice_unavailable", 400, /not set up/],
    ["invalid_audio", 400, /could not accept/],
  ] as const)("explains a %s rejection", async (reason, status, message) => {
    const fetchFn: typeof globalThis.fetch = async (input, init) =>
      new Request(input, init).method === "GET"
        ? json(READY)
        : json(
            {
              _tag: "EnvironmentRequestInvalidError",
              code: "invalid_request",
              reason,
              traceId: "trace",
            },
            status,
          );
    const prepared = await setup(fetchFn).prepare(options());
    await expect(prepared.transcribe("recording:1", options())).rejects.toMatchObject({
      code: "transcription-failed",
      message: expect.stringMatching(message),
    });
  });

  it("does not contact the environment for an empty recording", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => json(READY));
    const prepared = await setup(fetchFn, new Uint8Array(new ArrayBuffer(0))).prepare(options());
    fetchFn.mockClear();
    expect(await prepared.transcribe("recording:1", options())).toBe("");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("aborts the upload when the dictation is cancelled", async () => {
    const uploadStarted = Promise.withResolvers<void>();
    const fetchFn: typeof globalThis.fetch = (input, init) => {
      if (new Request(input, init).method === "GET") return Promise.resolve(json(READY));
      uploadStarted.resolve();
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    };
    const prepared = await setup(fetchFn).prepare(options());
    const controller = new AbortController();
    const upload = prepared.transcribe("recording:1", { signal: controller.signal });
    await uploadStarted.promise;
    controller.abort();
    await expect(upload).rejects.toBeDefined();
  });
});

const wavBytes = (chunks: ReadonlyArray<readonly [string, Uint8Array]>) => {
  const body = chunks.reduce((total, [, data]) => total + 8 + data.length + (data.length % 2), 0);
  const bytes = new Uint8Array(new ArrayBuffer(12 + body));
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < 4; index += 1)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  tag(0, "RIFF");
  view.setUint32(4, 4 + body, true);
  tag(8, "WAVE");
  let offset = 12;
  for (const [id, data] of chunks) {
    tag(offset, id);
    view.setUint32(offset + 4, data.length, true);
    bytes.set(data, offset + 8);
    offset += 8 + data.length + (data.length % 2);
  }
  return bytes;
};

const fmt = (format: {
  readonly encoding?: number;
  readonly channels?: number;
  readonly rate?: number;
  readonly bits?: number;
}) => {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, format.encoding ?? 1, true);
  view.setUint16(2, format.channels ?? 1, true);
  view.setUint32(4, format.rate ?? 16_000, true);
  view.setUint16(14, format.bits ?? 16, true);
  return bytes;
};

describe("pcmFromWav", () => {
  it("finds the samples past the padding chunks Apple's recorder adds", () => {
    const wav = wavBytes([
      ["fmt ", fmt({})],
      ["FLLR", new Uint8Array(4043)],
      ["data", PCM],
    ]);
    expect([...pcmFromWav(wav)!]).toEqual([...PCM]);
  });

  it("keeps the samples of a recording whose data length was never finalized", () => {
    const wav = wavBytes([
      ["fmt ", fmt({})],
      ["data", PCM],
    ]);
    new DataView(wav.buffer).setUint32(wav.length - PCM.length - 4, 0xffffffff, true);
    expect([...pcmFromWav(wav)!]).toEqual([...PCM]);
  });

  it.each([
    ["compressed", fmt({ encoding: 3 })],
    ["stereo", fmt({ channels: 2 })],
    ["another sample rate", fmt({ rate: 44_100 })],
    ["another bit depth", fmt({ bits: 24 })],
  ])("rejects %s audio rather than garbling it", (_, format) => {
    expect(
      pcmFromWav(
        wavBytes([
          ["fmt ", format],
          ["data", PCM],
        ]),
      ),
    ).toBeNull();
  });

  it.each([
    ["no format chunk", wavBytes([["data", PCM]])],
    ["a truncated header", new Uint8Array(new ArrayBuffer(4))],
    ["no data chunk", wavBytes([["fmt ", fmt({})]])],
  ])("rejects a file with %s", (_, wav) => {
    expect(pcmFromWav(wav)).toBeNull();
  });
});

describe("encodePcm16", () => {
  it("averages channels and clamps to the 16-bit range, little-endian", () => {
    const pcm = encodePcm16([new Float32Array([1, -1, 0.5, 2]), new Float32Array([1, -1, 0, 2])]);
    const view = new DataView(pcm.buffer);
    expect([0, 2, 4, 6].map((offset) => view.getInt16(offset, true))).toEqual([
      32767,
      -32768,
      Math.trunc(0.25 * 32767),
      32767,
    ]);
  });
});
