import { createFileRoute } from "@tanstack/react-router";
import { VoiceInputSettingsPanel } from "../components/settings/VoiceInputSettings";

export const Route = createFileRoute("/_chat/settings/voice-input")({
  component: VoiceInputSettingsPanel,
});
