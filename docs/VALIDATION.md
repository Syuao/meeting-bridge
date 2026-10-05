# Validation

The app is under active development. Website editor changes and service availability can affect results.

## Version 0.7.0

- All 74 Node tests passed. Added coverage verifies model preference persistence, routing to connection tests and capture, rejection of changes during listening/testing, Paraformer region constraints, and timestamp-based interim/final transcript updates without sentence IDs.
- Eight local browser checks passed for model selection, default preservation, history/binding retention, Qwen-only terminology input, region hints and disabled controls during recording/testing. Browser checks use synthetic state and do not start audio capture.
- A real Paraformer WebSocket test sent 4.503 seconds of synthetic English audio including trailing silence. Six provisional updates arrived, followed by the correct final text of two test questions. No microphone or meeting audio was captured. This is a short integration smoke test, not an accuracy or long-session benchmark.

## Version 0.6.2

- All 71 Node tests passed, including HTTP transport classification/redaction of Alibaba's `Arrearage` error and synchronous clipboard rejection/fallback handling.
- All 18 local browser panel checks passed. New scenarios cover starting a selection in paragraph padding, a failed copy followed by copy-only retry, a new selection during an unresolved draft fill, and a native range update after pointer release. Clipboard and draft delivery were mocked; these checks do not verify a user's operating-system clipboard or authenticated website.
- API error handling exposes only recognized error codes and predefined messages, never raw provider responses or quoted transcript text. Billing failures pause until an explicit retry; transient failures retain automatic backoff.

## Earlier versions

- 67 Node tests passed on the development Mac before publication preparation: transcription state, translation streaming/retries, draft append/deduplication, binding identity, clipboard, history and capture installation identity.
- Version 0.6.1 passed 14 existing browser panel interaction checks using local fixtures. No real meeting audio, API calls or website messages were used by those fixture checks.
- Version 0.6.0 passed four local browser editor fixtures for ChatGPT, DeepSeek, Qianwen and Qwen. This is not an authenticated end-to-end guarantee for every website version.
- A real Qwen-MT Native Messaging test ran for approximately three minutes with seven synthetic sentences; all seven completed. It did not capture live meeting audio. Synthetic failure tests covered 429 responses, timeouts, server errors and recovery.
- DeepSeek fallback translation passed a separate synthetic API test.
- The updated 0.6.1 panel was observed loaded in Chrome. Earlier user tests confirmed automatic clipboard copying and draft appending in ChatGPT.

The publication preparation successfully built the capture helper from an export of tracked source, ran all 67 Node tests, and installed the cloud-only route into disposable directories without bundled models or local ASR binaries. CI does not need API keys and does not record audio. The optional local Whisper worker was also built with the committed CMake configuration against the pinned upstream source; its installed executable links only system libraries/frameworks. The model download script verified an existing Whisper Base file against the pinned checksum; a fresh model download was not repeated.

Local raw test artifacts are intentionally excluded because they can contain environment details. No personal transcripts, real API keys or interview documents are included in the repository.

## Prebuilt release packaging

The Apple Silicon ZIP was extracted with macOS `ditto` into a disposable directory. Its `Install.command` ran with the bundled official Node.js 22.23.2 runtime, without using system Node or Python. The installed native host answered both hello and ping. A second install preserved the capture executable's inode/signature and a synthetic configuration file. The capture signature verified, and the bundled Node executable had no Homebrew library dependencies. The automated installer test additionally checks rejection of a damaged capture bundle and installation into paths containing spaces and an apostrophe.

The Node upstream archive is pinned by SHA-256. Release files are selected by an explicit allowlist and scanned for common secrets and personal absolute paths. This is not a notarization test or a fresh-machine Gatekeeper approval test. No Apple signing identity is configured; the capture program uses an ad-hoc signature. Only Apple Silicon is distributed as a prebuilt ZIP. Release testing does not change the developer's installed runtime or recording authorization.
