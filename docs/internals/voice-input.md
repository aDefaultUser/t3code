# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text to the agent. Mobile defaults to on-device transcription. Sending audio off
the device requires an explicit grant naming one environment and, for cloud
transcription, one provider. A separate [whisper.cpp path](#whispercpp-transcription)
also transcribes on the environment.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced. A
transcriber may expose a streaming session, in which case audio leaves during
capture and `finish` replaces the file-based `transcribe`.

## Where audio may go

On mobile, on-device transcription needs no audio grant. Environment and cloud
transcription share a recorder and upload only finished recordings. The client
keeps the grant in device-bound secure storage, outside preference backups, and
rechecks it after native decoding and before upload.

The [web grant](../../apps/web/src/speech/voiceConsent.ts) lives outside the preferences snapshot so another
window saving unrelated settings cannot resurrect a revoked grant. Each new choice
gets a distinct grant, even if the destination was previously selected. The
[web hook](../../apps/web/src/speech/useEnvironmentSpeechInput.ts) binds the
controller to that grant and the selected environment's connection. It requires
`voiceTranscription` to use the environment's model or `cloudVoiceTranscription`
to forward audio to the selected provider. Changing the grant or losing the
connection, permission, or required capability discards both the active recording
and any recording retained for retry. It never chooses a fallback destination.
The settings page's transcription test uses the same hook. The microphone loopback
test captures separately for local playback and sends nothing. The transport
refuses redirects so credentials and audio cannot follow one to another host.

Transcript cleanup requires its own grant, off by default.
It sends text, never audio, to the text generation provider of the draft's
own environment, because that is where the provider credentials live.

A cloud destination binds both the forwarding environment and the named provider.
It uses a separate, batch-only endpoint: changing a server key cannot upgrade
an environment-local grant, and a cloud recording never uses the streaming
socket or falls back to another provider or the environment's native model.

OpenRouter routes to many upstreams, so its grant also names the exact model and
the model travels with every upload as a query parameter. The server accepts only
ids present in OpenRouter's public ZDR-eligible transcription catalog,
which it caches for ten minutes after a successful read;
router aliases such as `openrouter/auto` or `:nitro` fail schema validation before
that. Requests set `provider.zdr` and carry no `models` fallback list. OpenRouter
applies the account's safety-retention policy when choosing an endpoint. The catalog
holds no credential or consent state, which is why it may be cached while key
presence is read fresh on every request.

## Server side

The [speech service](../../apps/server/src/speech/SpeechService.ts) runs
transcribe-cpp in a child process so a hung native call can be killed without
taking the server down; see [native.ts](../../apps/server/src/speech/native.ts)
for the packaging constraints (Node SEA, Electron ASAR). One native request runs
at a time. Batch uploads carry their options in the body framing defined in
[shared/speech.ts](../../packages/shared/src/speech.ts); streaming sends them in
the socket's first command. Model files and the selected model, hardware
placement, and unload timeout are environment state in server settings.

The Silero silence detector is optional. If its download fails, recordings use
raw audio during the retry cooldown so a detector outage cannot block dictation.
Explicitly installing a speech model also retries the detector without waiting.

## Cancellation and resource ownership

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results. On the server,
interrupting a batch request kills the worker process instead; the next request
reloads the model.

## whisper.cpp transcription

Independently of the speech service, an environment can run the user's own `whisper-cli`
per recording rather than linking a speech library or keeping a model loaded. A
provider-style CLI adds no native dependency to the server package and costs no memory
between recordings, at the price of loading the model each time. It has its own routes
under `/api/voice/whisper-cpp/`, its own `whisperCpp` server settings, and its own opt-in, so
it never reuses or widens a speech grant.

Clients upload raw 16 kHz 16-bit mono PCM and the [server](../../apps/server/src/voice/WhisperCpp.ts)
writes the WAV header, so whisper.cpp's audio decoders only ever see a container the
server built. Web decodes its `MediaRecorder` output with Web Audio, and mobile reuses the
native `decodeRecording` that environment speech uses. Keep decoding on the client;
depending on ffmpeg on the environment would break this for most installs.

Mobile recordings use whisper.cpp only after the user turns on its preference, and the
default must not change: a user who chose on-device transcription was told audio stays
there. If the thread's environment has whisper.cpp turned off, mobile falls back to the
**Transcribe on** choice instead of failing.
