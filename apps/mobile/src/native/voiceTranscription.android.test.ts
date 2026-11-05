import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  checkAvailability: vi.fn<() => Promise<boolean>>(),
  prepare: vi.fn<(id: number) => Promise<{ locale: string; mode: number }>>(),
  transcribe: vi.fn<(id: number, uri: string, locale: string, mode: number) => Promise<string>>(),
  cancel: vi.fn<(id: number) => Promise<void>>(),
  decodeRecordingToPcm: vi.fn<(id: number, uri: string) => Promise<string>>(),
  readFile: vi.fn<(uri: string) => Promise<ArrayBuffer>>(),
  deleteFile: vi.fn<(uri: string) => void>(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(private readonly uri: string) {}
    arrayBuffer = () => mocks.readFile(this.uri);
    delete = () => mocks.deleteFile(this.uri);
  },
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ isAvailable: () => true, ...mocks }),
}));

import {
  VoiceInputController,
  resetVoiceInputGlobalsForTests,
} from "../../../../packages/client-runtime/src/voice-input/controller";

import { getLocalVoiceTranscriber, readRecordingPcm } from "./voiceTranscription.android";

it("reads the decoded recording and leaves no copy behind, even if reading fails", async () => {
  vi.resetAllMocks();
  const options = { signal: new AbortController().signal };
  mocks.decodeRecordingToPcm.mockResolvedValue("file:///cache/upload.pcm");
  mocks.readFile.mockResolvedValueOnce(new Uint8Array([1, 0]).buffer);
  expect([...(await readRecordingPcm("file:///cache/take.m4a", options))]).toEqual([1, 0]);
  expect(mocks.decodeRecordingToPcm.mock.calls[0]?.[1]).toBe("file:///cache/take.m4a");
  expect(mocks.deleteFile).toHaveBeenCalledWith("file:///cache/upload.pcm");

  mocks.deleteFile.mockClear();
  mocks.readFile.mockRejectedValueOnce(new Error("read failed"));
  await expect(readRecordingPcm("file:///cache/take.m4a", options)).rejects.toThrow("read failed");
  expect(mocks.deleteFile).toHaveBeenCalledWith("file:///cache/upload.pcm");
});

it.each([false, true])(
  "waits for device support before offering a transcriber (%s)",
  async (supported) => {
    vi.resetAllMocks();
    const probe = Promise.withResolvers<boolean>();
    mocks.checkAvailability.mockReturnValue(probe.promise);
    let settled = false;
    const result = Promise.resolve(getLocalVoiceTranscriber()).then((transcriber) => {
      settled = true;
      return transcriber;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    probe.resolve(supported);
    expect((await result) !== null).toBe(supported);
  },
);

it.each([
  ["preparation", "storage", /disk|storage|space/i],
  ["preparation", "quota", /quota|limit/i],
  ["transcription", "storage", /disk|storage|space/i],
  ["transcription", "quota", /quota|limit/i],
] as const)("preserves an actionable %s error: %s", async (phase, code, expected) => {
  vi.resetAllMocks();
  resetVoiceInputGlobalsForTests();
  mocks.checkAvailability.mockResolvedValue(true);
  mocks.prepare.mockResolvedValue({ locale: "en-US", mode: 0 });
  mocks.transcribe.mockResolvedValue("Complete transcript.");
  mocks.cancel.mockResolvedValue(undefined);
  const rejection = Object.assign(new Error("Native SDK failure"), { code });
  (phase === "preparation" ? mocks.prepare : mocks.transcribe).mockRejectedValue(rejection);
  const transcriber = await getLocalVoiceTranscriber();
  const commit = vi.fn();
  const draft = {
    ownerKey: "acceptance:dictation",
    text: "Preserved draft.",
    selection: { start: 16, end: 16 },
    revision: 1,
  };
  const controller = new VoiceInputController({
    recorder: {
      uri: "file:///acceptance.m4a",
      prepareToRecordAsync: async () => {},
      record: () => {},
      stop: async () => {},
    },
    getTranscriber: () => transcriber,
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: () => {},
    readDraft: () => draft,
    commitDraft: commit,
    onStateChange: () => {},
  });
  await controller.start();
  if (phase === "transcription") await controller.stop();

  expect(controller.currentState).toMatchObject({ phase: "error", errorAction: "retry" });
  expect(commit).not.toHaveBeenCalled();
  expect(draft.text).toBe("Preserved draft.");
  expect(controller.currentState.error).toMatch(expected);
});
