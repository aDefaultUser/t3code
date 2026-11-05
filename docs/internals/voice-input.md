# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Mobile transcribes on the device unless the user opts in to the environment.
Web and desktop transcribe on the environment with whisper.cpp.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

## Environment transcription

The environment runs the user's own `whisper-cli` per recording rather than linking a
speech library or keeping a model loaded. A provider-style CLI adds no native dependency
to the server package and costs no memory between recordings, at the price of loading
the model each time.

Clients upload raw 16 kHz 16-bit mono PCM and the [server](../../apps/server/src/voice/WhisperCpp.ts)
writes the WAV header, so whisper.cpp's audio decoders only ever see a container the
server built. Recording can't use the browser's or Android's native encoders directly:
web decodes its `MediaRecorder` output with Web Audio, Android decodes AAC natively, and
iOS records WAV because it has no decoder module. Keep decoding on the client; depending
on ffmpeg on the environment would break this for most installs.

Mobile recordings stay on the device unless the user turns on the preference, and the
default must not change: a user who chose on-device transcription was told audio stays
there. If the environment has whisper.cpp turned off, mobile falls back to the device
instead of failing.
