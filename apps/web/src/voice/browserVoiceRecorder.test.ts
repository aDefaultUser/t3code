import type { VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

import { createBrowserVoiceRecorder, requestMicrophonePermission } from "./browserVoiceRecorder";

class FakeMediaRecorder extends EventTarget {
  static last: FakeMediaRecorder;
  static chunkBytes = 5;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";

  constructor(readonly stream: MediaStream) {
    super();
    FakeMediaRecorder.last = this;
  }

  start() {
    this.state = "recording";
  }

  finish() {
    this.state = "inactive";
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), {
        data: new Blob([new Uint8Array(FakeMediaRecorder.chunkBytes)], { type: "audio/webm" }),
      }),
    );
    this.dispatchEvent(new Event("stop"));
  }

  stop() {
    queueMicrotask(() => this.finish());
  }
}

function setup(permission: PermissionState | "unsupported" = "granted", holdChime = false) {
  vi.unstubAllGlobals();
  FakeMediaRecorder.chunkBytes = 5;
  const stopTrack = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia },
    permissions:
      permission === "unsupported"
        ? undefined
        : { query: vi.fn(async () => ({ state: permission })) },
  });
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      decodeAudioData = async () => ({
        numberOfChannels: 1,
        getChannelData: () => new Float32Array([0, 0.5]),
      });
    },
  );
  const statuses: VoiceRecorderStatus[] = [];
  const events: string[] = [];
  const chimeDone = { release: () => {} };
  const capture = createBrowserVoiceRecorder(
    (status) => statuses.push(status),
    (chime) => {
      events.push(`chime:${chime}`);
      return holdChime
        ? new Promise((resolve) => {
            chimeDone.release = resolve;
          })
        : Promise.resolve();
    },
  );
  return { capture, statuses, stopTrack, getUserMedia, events, chimeDone };
}

it("releases the microphone on stop and hands over the recording as PCM", async () => {
  const { capture, stopTrack } = setup();
  await capture.recorder.prepareToRecordAsync();
  capture.recorder.record({ forDuration: 300 });
  await capture.recorder.stop();
  expect(stopTrack).toHaveBeenCalledOnce();
  const pcm = await capture.readPcm(capture.recorder.uri!);
  expect(pcm.byteLength).toBe(4);
});

it.each([
  ["reads a near-empty file as nothing said", 5, 0],
  ["reports a real recording it cannot decode", 50_000, "error"],
] as const)("%s", async (_, chunkBytes, expected) => {
  const { capture } = setup();
  FakeMediaRecorder.chunkBytes = chunkBytes;
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      decodeAudioData = () => Promise.reject(new DOMException("bad", "EncodingError"));
    },
  );
  await capture.recorder.prepareToRecordAsync();
  capture.recorder.record({ forDuration: 300 });
  await capture.recorder.stop();
  const pcm = capture.readPcm(capture.recorder.uri!);
  if (expected === "error") await expect(pcm).rejects.toThrow("bad");
  else expect((await pcm).byteLength).toBe(expected);
});

it("keeps both chimes out of the recording, which whisper would hear as words", async () => {
  const { capture, events, chimeDone } = setup("granted", true);
  const preparing = capture.recorder.prepareToRecordAsync();
  let prepared = false;
  void preparing.then(() => {
    prepared = true;
  });
  await vi.waitFor(() => expect(events).toEqual(["chime:on"]));
  expect(prepared).toBe(false);
  chimeDone.release();
  await preparing;

  capture.recorder.record({ forDuration: 300 });
  expect(FakeMediaRecorder.last.state).toBe("recording");
  const stopped = capture.recorder.stop();
  expect(events).toEqual(["chime:on"]);
  await stopped;
  expect(FakeMediaRecorder.last.state).toBe("inactive");
  expect(events).toEqual(["chime:on", "chime:off"]);
});

it("plays the off chime when the browser ends the recording itself", async () => {
  const { capture, events } = setup();
  await capture.recorder.prepareToRecordAsync();
  capture.recorder.record({ forDuration: 300 });
  FakeMediaRecorder.last.finish();
  expect(events).toEqual(["chime:on", "chime:off"]);
});

it("does not start recording when cancelled during the on chime", async () => {
  const { capture, chimeDone, stopTrack } = setup("granted", true);
  const abort = new AbortController();
  const preparing = capture.recorder.prepareToRecordAsync(abort.signal);
  await vi.waitFor(() => expect(FakeMediaRecorder.last.state).toBe("inactive"));
  abort.abort();
  await vi.waitFor(() => chimeDone.release());
  chimeDone.release();
  await expect(preparing).rejects.toMatchObject({ code: "cancelled" });
  await capture.recorder.stop();
  expect(stopTrack).toHaveBeenCalledOnce();
});

it("does not keep a live microphone when cancelled during the permission prompt", async () => {
  const { capture, stopTrack } = setup();
  const abort = new AbortController();
  const preparing = capture.recorder.prepareToRecordAsync(abort.signal);
  abort.abort();
  await expect(preparing).rejects.toMatchObject({ code: "cancelled" });
  expect(stopTrack).toHaveBeenCalledOnce();
});

it("finishes with what was said when the browser ends the recording itself", async () => {
  const { capture, statuses, stopTrack } = setup();
  await capture.recorder.prepareToRecordAsync();
  capture.recorder.record({ forDuration: 300 });
  FakeMediaRecorder.last.finish();
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(statuses).toEqual([
    { isFinished: true, hasError: false, error: null, url: capture.recorder.uri },
  ]);
  expect((await capture.readPcm(statuses[0]!.url!)).byteLength).toBe(4);
});

it("does not report a stop it asked for as a browser-ended recording", async () => {
  const { capture, statuses } = setup();
  await capture.recorder.prepareToRecordAsync();
  capture.recorder.record({ forDuration: 300 });
  await capture.recorder.stop();
  expect(statuses).toEqual([]);
});

it("keeps no audio when a discard beats the recorder's late stop event", async () => {
  const { capture } = setup();
  await capture.recorder.prepareToRecordAsync();
  capture.recorder.record({ forDuration: 300 });
  const uri = capture.recorder.uri!;
  capture.deleteRecording(uri);
  FakeMediaRecorder.last.finish();
  await expect(capture.readPcm(uri)).rejects.toThrow("no longer available");
});

it("stops at the recording limit and reports the finished recording", async () => {
  const { capture, statuses, stopTrack } = setup();
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
  await capture.recorder.prepareToRecordAsync();
  capture.recorder.record({ forDuration: 300 });
  await vi.advanceTimersByTimeAsync(299_000);
  expect(statuses).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(statuses).toEqual([
    { isFinished: true, hasError: false, error: null, url: capture.recorder.uri },
  ]);
});

it.each([
  ["granted", 0],
  ["prompt", 1],
  ["unsupported", 1],
  // Electron's check handler can say denied while its request handler still allows the microphone.
  ["denied", 1],
] as const)("asks getUserMedia unless permission is known granted: %s", async (state, calls) => {
  const { getUserMedia, stopTrack } = setup(state);
  await expect(requestMicrophonePermission()).resolves.toMatchObject({ granted: true });
  expect(getUserMedia).toHaveBeenCalledTimes(calls);
  expect(stopTrack).toHaveBeenCalledTimes(calls);
});

it("reports a refused microphone as not granted", async () => {
  const { getUserMedia } = setup("prompt");
  getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  await expect(requestMicrophonePermission()).resolves.toEqual({
    granted: false,
    canAskAgain: false,
  });
});
