import { useAtomValue } from "@effect/atom-react";
import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  RecordingPresets,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import { makeMutable } from "react-native-reanimated";

import {
  type MicrophoneEntry,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber, readRecordingPcm } from "../../native/voiceTranscription";
import { connectionAtomRuntime } from "../../connection/runtime";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  createEnvironmentVoiceTranscriber,
  createVoiceRequestRunner,
  voiceInputBlocksSubmission,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import { createVoiceRecordingPermission } from "./voiceRecordingPermission";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
};

// iOS can record whisper.cpp's format directly; Android records AAC and decodes natively.
const IOS_WHISPER_RECORDING_OPTIONS = {
  extension: ".wav",
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 256_000,
  isMeteringEnabled: true,
  outputFormat: IOSOutputFormat.LINEARPCM,
  audioQuality: AudioQuality.MAX,
  linearPCMBitDepth: 16 as const,
  linearPCMIsBigEndian: false,
  linearPCMIsFloat: false,
};

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

export const deviceMicrophoneOrder = (saved?: ReadonlyArray<MicrophoneEntry>) =>
  microphoneOrder(saved, Platform.OS === "android" ? "android" : "ios");

/** "checking" until the first availability probe settles; re-probed on foreground. */
export const localVoiceTranscriberAtom = makePermissionStatusAtom<
  VoiceTranscriber | null | "checking"
>({
  label: "mobile:voice-input:transcriber",
  initial: "checking",
  read: () => getLocalVoiceTranscriber().catch(() => null),
}).pipe(Atom.keepAlive);

// Each foreground re-probe yields a new transcriber; composers re-render only when availability flips.
const localVoiceInputAvailableAtom = Atom.make((get) => {
  const transcriber = get(localVoiceTranscriberAtom);
  return transcriber !== null && transcriber !== "checking";
});

const NO_WHISPER_ATOM = Atom.make(false).pipe(Atom.withLabel("mobile:voice-input:no-whisper"));
const whisperEnabledAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const preferences = get(mobilePreferencesAtom);
    const config = get(serverEnvironment.configValueAtom(environmentId));
    return (
      AsyncResult.isSuccess(preferences) &&
      preferences.value.voiceTranscriptionEngine === "whisper-cpp" &&
      config?.environment.capabilities.whisperCppTranscription === true &&
      config.settings.whisperCpp.enabled
    );
  }).pipe(Atom.withLabel(`mobile:voice-input:whisper-enabled:${environmentId}`)),
);

/** A boolean, so composers re-render when dictation flips, not on every preference or config change. */
export function useWhisperEnabled(environmentId: EnvironmentId | undefined): boolean {
  return useAtomValue(
    environmentId === undefined ? NO_WHISPER_ATOM : whisperEnabledAtom(environmentId),
  );
}

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read and remember microphones synchronously.
  get.mount(mobilePreferencesAtom);
  get.mount(updateMobilePreferencesAtom);
  get.mount(localVoiceTranscriberAtom);
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
  const permission = createVoiceRecordingPermission(() => {
    void session.controller.appMovedToBackground();
  });
  const whisperTranscriber = (environmentId: EnvironmentId) =>
    createEnvironmentVoiceTranscriber({
      getPrepared: () =>
        Option.getOrNull(
          registry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
        ),
      run: createVoiceRequestRunner(registry, connectionAtomRuntime),
      readPcm: readRecordingPcm,
      deviceLocale: () => Intl.DateTimeFormat().resolvedOptions().locale,
    });
  // Re-read here so a retry after opting out never uploads to the environment.
  const activeWhisperEnvironmentId = () => {
    const preferences = registry.get(mobilePreferencesAtom);
    return AsyncResult.isSuccess(preferences) &&
      preferences.value.voiceTranscriptionEngine === "whisper-cpp"
      ? session.whisperEnvironmentId
      : null;
  };
  let recorderUsesWhisper = false;
  const recorder = createLazyVoiceRecorder({
    create: () => {
      recorderUsesWhisper = activeWhisperEnvironmentId() !== null;
      return new AudioModule.AudioRecorder(
        recorderUsesWhisper && Platform.OS === "ios"
          ? IOS_WHISPER_RECORDING_OPTIONS
          : VOICE_RECORDING_OPTIONS,
      );
    },
    onStatus: (status: RecordingStatus) => {
      session.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    },
    // Read when recording starts so preference changes do not re-render every composer.
    selectInput: (inputs) => {
      const preferences = registry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(preferences)) return null;
      const known = deviceMicrophoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(deviceMicrophoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    getTranscriber: () => {
      const environmentId = activeWhisperEnvironmentId();
      if (environmentId !== null) return whisperTranscriber(environmentId);
      const transcriber = registry.get(localVoiceTranscriberAtom);
      return transcriber === "checking" ? null : transcriber;
    },
    requestPermission: permission.requestPermission,
    configureRecording: async () => {
      // Recording options are fixed at construction, so a change of engine needs a new recorder.
      if (recorderUsesWhisper !== (activeWhisperEnvironmentId() !== null)) recorder.release();
      const token = acquireAudioSession("recording");
      audioToken = token;
      try {
        await activateAudioSession(token);
      } catch (error) {
        await releaseAudioSession(token).catch(() => {});
        throw error;
      }
    },
    releaseRecording: async () => {
      if (audioToken) await releaseAudioSession(audioToken);
      audioToken = null;
    },
    deleteRecording: (uri) => new File(uri).delete(),
    sampleRecording: () => {
      const status = recorder.getStatus();
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  get.addFinalizer(() => {
    permission.dispose();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const isTranscriberAvailable = useAtomValue(localVoiceInputAvailableAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snapshot,
    isAvailable: isTranscriberAvailable || getNativeShowcaseScene() !== null,
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
  };
}
