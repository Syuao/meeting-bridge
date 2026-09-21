# Third-party components

Meeting Bridge source is MIT licensed. Third-party software and model weights retain their own licenses.

- [ws](https://github.com/websockets/ws): MIT. Installed by npm; its license remains in `node_modules/ws/LICENSE`.
- [Node.js](https://nodejs.org/): the prebuilt Apple Silicon release includes the official Node.js 22 runtime. Its full license and bundled dependency notices are included in `node-runtime/LICENSE`; the upstream archive SHA-256 is pinned in `scripts/build_release.py`.
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp): MIT. Optional local ASR build pins commit `da54572229bcf64ba367d96c7ef15770376c4280`. A copy of its notice is in `LICENSE.whisper.cpp.txt`; dependencies fetched by CMake retain their upstream notices.
- [nlohmann/json](https://github.com/nlohmann/json): MIT. The optional ASR worker uses whisper.cpp's bundled `examples/json.hpp`, which includes the upstream license notice.
- [Whisper model weights](https://huggingface.co/ggerganov/whisper.cpp): downloaded separately for optional local ASR. See [OpenAI Whisper](https://github.com/openai/whisper/blob/main/LICENSE) and the model distributor for license details. We do not commit model weights.

Alibaba Cloud, DeepSeek, ChatGPT, Qwen and Tencent Meeting are independent third-party services. Their services, names and logos are not covered by this repository's MIT license. Meeting Bridge is an independent project.
