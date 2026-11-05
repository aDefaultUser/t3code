import {
  createVoiceRequestRunner,
  getEnvironmentVoiceStatus,
  voiceIssueMessage,
} from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, EnvironmentVoiceStatus, WhisperCppSettings } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const runStatusRequest = createVoiceRequestRunner(appAtomRegistry, connectionAtomRuntime);

type TextSettingKey = "binaryPath" | "modelPath" | "language";

function WhisperTextRow(props: {
  readonly settingId: Parameters<typeof searchableSetting>[0];
  readonly settingKey: TextSettingKey;
  readonly description: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onSave: (value: string) => void;
}) {
  return (
    <SettingsRow
      {...searchableSetting(props.settingId)}
      description={props.description}
      serverScoped
      settingKeys={["whisperCpp"]}
      managedPaths={[`whisperCpp.${props.settingKey}`]}
      control={
        <Input
          // Remounts when another client saves, since the field keeps its own text while typing.
          key={props.value}
          aria-label={searchableSetting(props.settingId).title}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={props.placeholder}
          defaultValue={props.value}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value !== props.value) props.onSave(value);
          }}
        />
      }
    />
  );
}

function WhisperCppStatus(props: { readonly environmentId: EnvironmentId }) {
  const [status, setStatus] = useState<EnvironmentVoiceStatus | "failed" | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the environment whether its filesystem matches the settings this status was mounted for
  useEffect(() => {
    const prepared = readPreparedConnection(props.environmentId);
    if (!prepared) {
      // oxlint-disable-next-line react/set-state-in-effect -- The connection is external state, and without one the check has already failed.
      setStatus("failed");
      return;
    }
    const controller = new AbortController();
    runStatusRequest(getEnvironmentVoiceStatus(prepared), { signal: controller.signal }).then(
      (next) => {
        if (!controller.signal.aborted) setStatus(next);
      },
      () => {
        if (!controller.signal.aborted) setStatus("failed");
      },
    );
    return () => controller.abort();
  }, [props.environmentId]);

  if (status === null) return "Checking…";
  if (status === "failed") return "Could not check this environment.";
  if (status.issue !== null) return voiceIssueMessage(status.issue);
  return `Ready, using ${status.binaryPath ?? "whisper.cpp"}.`;
}

function WhisperCppSection(props: { readonly environmentId: EnvironmentId }) {
  const { environment } = useSettingsScope();
  const settings: WhisperCppSettings = useScopedSettings((scoped) => scoped.whisperCpp);
  const updateSettings = useUpdateScopedSettings();
  const save = (patch: Partial<WhisperCppSettings>) => updateSettings({ whisperCpp: patch });
  const supported =
    environment?.serverConfig?.environment.capabilities.whisperCppTranscription === true;
  const { enabled, binaryPath, modelPath, language } = settings;

  if (!supported) {
    return (
      <SettingsSection id="voice-input-whisper-section" title="whisper.cpp">
        <SettingsScopeNotice target="environment">
          Update T3 Code on this environment to use whisper.cpp dictation.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection id="voice-input-whisper-section" title="whisper.cpp">
      <SettingsRow
        {...searchableSetting("voice-input-whisper")}
        description="Adds a microphone to the composer on web and desktop. Audio goes to this environment, is transcribed there, and is deleted right after."
        status={
          enabled ? (
            <WhisperCppStatus
              key={`${binaryPath}\0${modelPath}\0${language}`}
              environmentId={props.environmentId}
            />
          ) : undefined
        }
        serverScoped
        settingKeys={["whisperCpp"]}
        managedPaths={["whisperCpp.enabled"]}
        control={
          <Switch
            aria-label="Dictate with whisper.cpp"
            checked={enabled}
            onCheckedChange={(checked) => save({ enabled: checked })}
          />
        }
      />
      <WhisperTextRow
        settingId="voice-input-whisper-binary"
        settingKey="binaryPath"
        description="Full path to whisper-cli on this environment. Leave empty to find whisper-cli or whisper-cpp on its PATH."
        placeholder="whisper-cli"
        value={binaryPath}
        onSave={(value) => save({ binaryPath: value })}
      />
      <WhisperTextRow
        settingId="voice-input-whisper-model"
        settingKey="modelPath"
        description="Full path to a ggml model file on this environment, such as ~/models/ggml-base.en.bin."
        placeholder="~/models/ggml-base.en.bin"
        value={modelPath}
        onSave={(value) => save({ modelPath: value })}
      />
      <WhisperTextRow
        settingId="voice-input-whisper-language"
        settingKey="language"
        description="A language code such as en or fr, or auto to detect it. English-only models always use English."
        placeholder="auto"
        value={language}
        onSave={(value) => save({ language: value === "" ? "auto" : value })}
      />
    </SettingsSection>
  );
}

export function VoiceInputSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {scope.kind === "environment" && environment ? (
        <WhisperCppSection
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <SettingsSection id="voice-input-whisper-section" title="whisper.cpp">
          <SettingsScopeNotice target="environment">
            Choose one environment to set up dictation on it.
          </SettingsScopeNotice>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
