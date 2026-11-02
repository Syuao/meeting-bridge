# Validation

The app is under active development. Website editor changes and service availability can affect results.

## Version 0.9.3

- All 114 Node tests pass. New cases cover either binding button connecting both selected endpoints, enabling automatic mode after navigation, and refreshing the room document token without a second reconnect.
- Markdown tests use real ProseMirror schema/state/transactions. Partial updates replace the same answer paragraph, explicit newlines and indentation survive, later selections append, unrelated preceding edits are retained, and manual edits to an owned paragraph stop updates.
- Authenticated Chrome loaded 0.9.3. In a real ShareCode Markdown room, toggling automatic mode alone connected both endpoints and passed the health check. With automatic mode off, selecting a neutral sentence in ChatGPT visibly appended it to the Markdown editor. That test append was undone. Automatic mode was restored without pressing either binding button.
- Markdown uses a separate Milkdown/ProseMirror editor rather than Monaco. Switching editor families during an existing answer pauses that answer to avoid duplicating it; reconnect before a new answer/selection. A live generated Markdown answer was not repeated in this validation; streaming behavior was exercised with real ProseMirror transactions in tests.
- Only extension code and development dependencies changed. The installed audio helper and recording permissions were not modified.

## Version 0.9.2

- All 109 Node tests pass. New cases cover rebinding after same-tab conversation/room navigation with a stale sender document URL, list items containing paragraph/div wrappers, and Monaco model replacement with both unchanged and changed content.
- Authenticated Chrome confirmed extension version 0.9.2 loaded. Reconnecting the current conversation/room passed the source/room health check. Switching ShareCode from JavaScript to Python preserved the connection; selecting a neutral heading appended it to the room. Switching back to JavaScript retained the written text.
- The loaded browser version before this update was still 0.9.0. Existing 489 transcript rows and 103 selected excerpts were retained. No audio helper or permissions were changed.
- Model replacement migrates tracked ranges only when the full document text and recorded ranges are verified; changed content cannot be overwritten by the old stream. A real page reload or room change still requires explicit rebinding.

## Version 0.9.1

- All 105 Node tests pass. Added regression cases reproduce a transient heartbeat failure permanently removing listeners and invalidated-runtime cleanup blocking reinjection; both now recover.
- Binding requires acknowledgement of the current source mode and epoch before reporting ready. The new connection check probes both the source listener and the room document without writing text.
- The user confirmed manual selections working again after reload/reconnection. The original failing browser event was not logged, so the precise trigger is not proven; the regression cases establish concrete recovery defects rather than a definitive diagnosis of that event.
- Only extension code is updated. No capture app, credentials, permissions, or stored transcript data are changed.

## Version 0.9.0

- 101 Node tests pass, covering partial-answer forwarding before completion, selection during generation, current ChatGPT markup, mode changes, duplicate delivery, room editing conflicts, page refresh, whitespace cleanup, and the existing capture/history/draft tests.
- On the authenticated Chrome pages, selected ChatGPT answer text was appended to the bound ShareCode editor while preserving its existing text. A live generated test answer appeared in ShareCode while ChatGPT still displayed its Stop button. Switching to manual mode and selecting text also appended the selection.
- After loading the final whitespace fix, selecting a heading with its paragraph and then a second heading produced three consecutive nonempty ShareCode lines, with no blank line within or between selections.
- Extension reloads preserved the existing 442 transcript rows and 110 selected excerpts. The final update changes extension code only; the installed audio app, signature, permissions and credentials are not replaced.
- Website checks use a test prompt, not meeting audio. No long-session performance claim is made. ChatGPT is the only answer-source adapter in this version; other supported sites retain draft insertion.

## Version 0.7.1

- All 78 Node tests passed, including compact audio meter messages, unchanged delivery failures avoiding repeated history broadcasts, receiver upgrades, and a read-only composer reconnect check.
- All 21 local panel checks passed. They cover repeated selection/copy/append, pending fills, selection protection during transcript revisions, loading older history, a bounded live window, and meter updates making no transcript DOM mutations.
- All nine browser composer checks passed. They exercise multiple editors, a labelled ChatGPT composer, hidden stale editors, wrapper IDs, delayed mounting, navigation during recovery, ambiguous editors, idle heartbeats, and reinjection deduplication. Run a local HTTP server at the repository root and open `tests/browser/composer.html` to repeat these synthetic checks.
- A local in-app browser comparison with 2,400 synthetic bilingual paragraphs measured the synchronous selection-release handler at 132.7 ms before and 0.2 ms after the change; the live DOM reduced from 2,400 to 200 paragraphs. Initial rendering measured 190.8 ms before and 13.6 ms after. These single-run fixture measurements exclude real clipboard/ChatGPT/network work and do not measure or guarantee the disappearance of macOS beachballs.
- No real meeting audio or transcript was transmitted for these tests. Actual website updates, long conversations, other extensions, and OS clipboard behavior can still affect latency.

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
