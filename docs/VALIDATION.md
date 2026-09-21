# Validation

The app is under active development. Website editor changes and service availability can affect results.

- 67 Node tests passed on the development Mac before publication preparation: transcription state, translation streaming/retries, draft append/deduplication, binding identity, clipboard, history and capture installation identity.
- Version 0.6.1 passed 14 existing browser panel interaction checks using local fixtures. No real meeting audio, API calls or website messages were used by those fixture checks.
- Version 0.6.0 passed four local browser editor fixtures for ChatGPT, DeepSeek, Qianwen and Qwen. This is not an authenticated end-to-end guarantee for every website version.
- A real Qwen-MT Native Messaging test ran for approximately three minutes with seven synthetic sentences; all seven completed. It did not capture live meeting audio. Synthetic failure tests covered 429 responses, timeouts, server errors and recovery.
- DeepSeek fallback translation passed a separate synthetic API test.
- The updated 0.6.1 panel was observed loaded in Chrome. Earlier user tests confirmed automatic clipboard copying and draft appending in ChatGPT.

The publication preparation successfully built the capture helper from an export of tracked source, ran all 67 Node tests, and installed the cloud-only route into disposable directories without bundled models or local ASR binaries. CI does not need API keys and does not record audio. Optional local Whisper ASR is built separately; its model is downloaded with checksum verification.

Local raw test artifacts are intentionally excluded because they can contain environment details. No personal transcripts, real API keys or interview documents are included in the repository.
