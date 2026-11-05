import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function RecordingElapsed() {
  const [seconds, setSeconds] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks a once-a-second clock only while this recording label is mounted
  useEffect(() => {
    const interval = setInterval(() => setSeconds((current) => current + 1), 1_000);
    return () => clearInterval(interval);
  }, []);
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <span className="text-muted-foreground text-xs tabular-nums">{label}</span>;
}

function DictationButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={props.disabled}
            // Keeps the editor's selection, which is where the transcript goes.
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onClick}
            aria-label={props.label}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function ComposerDictationControl(props: {
  readonly phase: VoiceInputPhase;
  readonly environmentLabel: string;
  readonly unsupportedReason: string | null;
  readonly shortcutLabel: string | null;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onCancel: () => void;
}) {
  if (props.phase === "idle" || props.phase === "error") {
    const label =
      props.unsupportedReason ??
      `Dictate, transcribed on ${props.environmentLabel}${
        props.shortcutLabel ? ` (${props.shortcutLabel})` : ""
      }`;
    return (
      <DictationButton
        label={label}
        onClick={props.onStart}
        disabled={props.unsupportedReason !== null}
      >
        <MicIcon />
      </DictationButton>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1" role="status">
      {props.phase === "recording" ? <RecordingElapsed /> : null}
      <DictationButton label="Cancel dictation" onClick={props.onCancel}>
        <XIcon />
      </DictationButton>
      {props.phase === "recording" ? (
        <DictationButton label="Finish dictating" onClick={props.onStop}>
          <SquareIcon className="fill-current text-destructive" />
        </DictationButton>
      ) : (
        <span aria-label={props.phase === "preparing" ? "Preparing dictation" : "Transcribing"}>
          <Spinner size="md" tone="muted" />
        </span>
      )}
    </div>
  );
}
