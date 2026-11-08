import {
  createWhisperCppTranscriber,
  createVoiceRequestRunner,
  VoiceInputController,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";
import { createBrowserVoiceRecorder, requestMicrophonePermission } from "./browserVoiceRecorder";

type Selection = { readonly start: number; readonly end: number };

type ComposerDictationInput = {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  /** Environment speech input shares the one microphone session, so it must finish first. */
  readonly otherVoiceInputActive: boolean;
  readonly readDraft: () => { readonly text: string; readonly selection: Selection } | null;
  readonly commitDraft: (text: string, selection: Selection) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
};

function createComposerDictation(initial: ComposerDictationInput) {
  // A transcript finishes asynchronously and must reach the composer's current draft.
  let input = initial;
  const capture = createBrowserVoiceRecorder((status) => {
    void controller.handleRecorderStatus(status);
  });
  const transcriber = createWhisperCppTranscriber({
    getPrepared: () => readPreparedConnection(input.environmentId),
    run: createVoiceRequestRunner(appAtomRegistry, connectionAtomRuntime),
    readPcm: (uri) => capture.readPcm(uri),
    deviceLocale: () => navigator.language,
  });
  const controller = new VoiceInputController({
    recorder: capture.recorder,
    getTranscriber: () => transcriber,
    requestPermission: requestMicrophonePermission,
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: capture.deleteRecording,
    readDraft: () => {
      const draft = input.readDraft();
      // The editor is frozen while dictating, so comparing text is enough to detect a change.
      return draft && { ...draft, ownerKey: input.ownerKey, revision: 0 };
    },
    commitDraft: (text, selection) => input.commitDraft(text, selection),
    onStateChange: (next) => {
      input.onStateChange(next);
      if (next.phase === "error" && next.error) {
        toastManager.add({ type: "error", title: "Dictation stopped", description: next.error });
      }
    },
  });
  return {
    controller,
    setInput: (next: ComposerDictationInput) => {
      // A recording belongs to the draft it started in, so switching drafts cancels it.
      if (next.ownerKey !== input.ownerKey) controller.ownerChanged();
      input = next;
    },
  };
}

export function useComposerDictation(input: ComposerDictationInput) {
  const [{ controller, setInput }] = useState(() => createComposerDictation(input));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed draft callbacks to the controller, which outlives each render
  useLayoutEffect(() => {
    setInput(input);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the microphone and any running transcription must not outlive the composer
  useEffect(() => () => controller.dispose(), [controller]);

  const start = () => {
    if (!input.otherVoiceInputActive) void controller.start();
  };
  return {
    start,
    stop: () => void controller.stop(),
    cancel: () => controller.cancel(),
    toggle: () => {
      const { phase } = controller.currentState;
      if (phase === "recording") void controller.stop();
      else if (phase === "idle" || phase === "error") start();
    },
  };
}
