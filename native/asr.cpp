#include "whisper.h"
#include "json.hpp"
#include <fstream>
#include <iostream>
#include <vector>
#include <chrono>
using json = nlohmann::json;
int main(int argc, char ** argv) {
    if (argc != 2) return 1;
    auto cp = whisper_context_default_params();
    cp.use_gpu = true;
    auto ctx = whisper_init_from_file_with_params(argv[1], cp);
    if (!ctx) { std::cout << json({{"type","error"},{"message","Cannot load speech model"}}).dump() << std::endl; return 2; }
    std::cout << json({{"type","ready"}}).dump() << std::endl;
    std::string line;
    while (std::getline(std::cin, line)) {
        json req;
        try {
            req = json::parse(line);
            std::string path = req.at("path");
            std::ifstream file(path, std::ios::binary | std::ios::ate);
            if (!file) throw std::runtime_error("Audio file is missing");
            auto size = file.tellg();
            if (size <= 0 || size > 16000 * 4 * 35 || size % 4) throw std::runtime_error("Invalid audio length");
            std::vector<float> samples(size / 4); file.seekg(0); file.read(reinterpret_cast<char*>(samples.data()), size);
            for (auto & value : samples) if (!std::isfinite(value)) value = 0;
            auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
            std::string language = req.value("language", "auto");
            if (language != "en" && language != "zh") language = "auto";
            params.language = language.c_str();
            params.n_threads = 4;
            params.translate = false;
            params.no_context = true;
            params.single_segment = false;
            params.print_realtime = params.print_progress = params.print_timestamps = params.print_special = false;
            params.suppress_nst = true;
            params.temperature = 0;
            params.temperature_inc = 0;
            params.no_speech_thold = 0.65;
            auto begin = std::chrono::steady_clock::now();
            if (whisper_full(ctx, params, samples.data(), samples.size())) throw std::runtime_error("Speech inference failed");
            std::string text;
            for (int i = 0; i < whisper_full_n_segments(ctx); i++) text += whisper_full_get_segment_text(ctx, i);
            auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - begin).count();
            std::cout << json({{"type","transcript"},{"id",req.at("id")},{"text",text},{"ms",ms},{"language",whisper_lang_str(whisper_full_lang_id(ctx))}}).dump() << std::endl;
        } catch (const std::exception & e) {
            std::cout << json({{"type","error"},{"id",req.value("id","")},{"message",e.what()}}).dump() << std::endl;
        }
    }
    whisper_free(ctx);
}
