import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { useComposerDictation } from "./useComposerDictation";

const mocks = vi.hoisted(() => ({
  dictation: undefined as unknown as ReturnType<typeof useComposerDictation>,
  requestMicrophonePermission: vi.fn(async () => ({ granted: false, canAskAgain: false })),
  states: [] as VoiceInputState["phase"][],
}));

vi.mock("./browserVoiceRecorder", () => ({
  createBrowserVoiceRecorder: () => ({
    recorder: {
      uri: null,
      prepareToRecordAsync: async () => undefined,
      record: () => undefined,
      stop: async () => undefined,
    },
    readPcm: async () => new Uint8Array(),
    deleteRecording: () => undefined,
  }),
  requestMicrophonePermission: mocks.requestMicrophonePermission,
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/session", () => ({ readPreparedConnection: () => null }));

function setup() {
  mocks.requestMicrophonePermission.mockClear();
  mocks.states = [];
}

function Probe(props: { readonly otherVoiceInputActive: boolean }) {
  const dictation = useComposerDictation({
    environmentId: EnvironmentId.make("env"),
    ownerKey: "draft",
    otherVoiceInputActive: props.otherVoiceInputActive,
    readDraft: () => ({ text: "", selection: { start: 0, end: 0 } }),
    commitDraft: () => undefined,
    onStateChange: (state) => mocks.states.push(state.phase),
  });
  useLayoutEffect(() => {
    mocks.dictation = dictation;
  });
  return null;
}

it("does not start while another voice input holds the microphone", async () => {
  setup();
  await using screen = await render(<Probe otherVoiceInputActive />);
  await act(() => {
    mocks.dictation.start();
    mocks.dictation.toggle();
  });
  expect(mocks.states).toEqual([]);
  expect(mocks.requestMicrophonePermission).not.toHaveBeenCalled();

  await screen.rerender(<Probe otherVoiceInputActive={false} />);
  await act(() => mocks.dictation.toggle());
  await vi.waitFor(() => expect(mocks.requestMicrophonePermission).toHaveBeenCalledOnce());
  expect(mocks.states[0]).toBe("preparing");
});
