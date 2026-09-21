# Contributing

Issues and pull requests are welcome. Describe the problem, expected behavior, OS/Chrome version and a minimal reproduction. Use synthetic transcript text and remove API keys, personal meeting content and browser conversation links from logs or screenshots.

## Development

1. Install Node.js 22+, Python 3 and Xcode Command Line Tools on macOS.
2. Run `npm ci --ignore-scripts` and `python3 scripts/build_capture.py`.
3. Run `npm test` before submitting changes. For panel or composer changes, also verify the relevant browser interaction with a disposable draft; never send test messages to someone else's conversation.
4. Stage the intended files and run `python3 scripts/check_repository.py`. Review `git diff --cached` before committing.

Keep generated models, binaries, API configuration and local diagnostics out of commits. Do not add telemetry or silently change which service receives audio or transcript text. Preserve drafts, history, selection behavior and existing capture permissions when changing installation code.

Contributions are provided under the repository's MIT license. Do not include third-party code without its compatible license notice.
