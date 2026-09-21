import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import Vision
import Darwin

// Captures the selected application's OUTPUT audio, never the microphone.
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    let dir: URL
    let source: String
    let parentPID: pid_t
    let streamPCM: Bool
    let background: Bool
    var pcm = [Int16]()
    let queue = DispatchQueue(label: "meetingbridge.audio")
    var stream: SCStream?
    var converter: AVAudioConverter?
    var sourceFormat: AVAudioFormat?
    let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    var preRoll = [Float]()
    var speech = [Float]()
    var quietFrames = 0
    var voicedFrames = 0
    var active = false
    var sequence = 0
    var eventSequence = 0
    var stopping = false
    var lastLevel = Date.distantPast
    var lastSample = Date()
    var lastVoiceAt = Date()
    var lastPreviewFrames = 0
    var piece = 0
    var lastOCR = Date.distantPast
    var timer: Timer?
    var window: NSWindow!
    var label: NSTextField!
    var level: NSProgressIndicator!

    init(dir: URL, source: String, parentPID: pid_t, streamPCM: Bool = false, background: Bool = false) {
        self.dir = dir; self.source = source; self.parentPID = parentPID; self.streamPCM = streamPCM; self.background = background
        super.init()
    }
    func emit(_ value: [String: Any]) {
        // Audio callbacks and control events share this serial queue.
        eventSequence += 1
        var obj = value; obj["at"] = Int(Date().timeIntervalSince1970 * 1000)
        if let data = try? JSONSerialization.data(withJSONObject: obj) {
            try? data.write(to: dir.appendingPathComponent(String(format: "event-%08d.json", eventSequence)), options: .atomic)
        }
    }
    func showWindow() {
        NSApplication.shared.setActivationPolicy(background ? .accessory : .regular)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 200), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Meeting Bridge · 声音采集"
        window.center()
        let title = NSTextField(labelWithString: source == "tencent-text" ? "读取腾讯实时转写" : source == "all" ? "系统声音" : "腾讯会议声音")
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        title.frame = NSRect(x: 26, y: 142, width: 405, height: 30)
        label = NSTextField(wrappingLabelWithString: "正在准备声音共享…")
        label.frame = NSRect(x: 26, y: 80, width: 405, height: 50)
        label.font = .systemFont(ofSize: 14)
        level = NSProgressIndicator(frame: NSRect(x: 26, y: 56, width: 405, height: 12))
        level.isIndeterminate = false; level.minValue = 0; level.maxValue = 1
        let button = NSButton(title: "停止采集", target: self, action: #selector(stopClicked))
        button.frame = NSRect(x: 327, y: 15, width: 108, height: 30)
        window.contentView?.addSubview(title); window.contentView?.addSubview(label)
        window.contentView?.addSubview(level); window.contentView?.addSubview(button)
        if !background { window.makeKeyAndOrderFront(nil) }
        let visible = window.isVisible
        queue.async { self.emit(["type": "capture_ui", "background": self.background, "windowVisible": visible]) }
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            guard let self else { return }
            if FileManager.default.fileExists(atPath: self.dir.appendingPathComponent("stop").path) || kill(self.parentPID, 0) != 0 || (!self.background && !self.window.isVisible && !self.window.isMiniaturized) {
                Task { await self.stop() }
            }
        }
    }
    @objc func stopClicked() { Task { await stop() } }
    func start() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            if stopping { return }
            if source == "tencent-text" {
                let windows = content.windows.filter { $0.owningApplication?.bundleIdentifier == "com.tencent.meeting" && $0.frame.width > 450 && $0.frame.height > 300 }
                guard let target = windows.sorted(by: { a,b in
                    if (a.title == "腾讯会议") != (b.title == "腾讯会议") { return a.title == "腾讯会议" }
                    return a.frame.width*a.frame.height > b.frame.width*b.frame.height
                }).first else { throw NSError(domain: "MeetingBridge", code: 3, userInfo: [NSLocalizedDescriptionKey: "请打开腾讯会议，并展开右侧「实时转写」面板。"] ) }
                let filter = SCContentFilter(desktopIndependentWindow: target)
                let config = SCStreamConfiguration()
                config.width = Int(target.frame.width * 2); config.height = Int(target.frame.height * 2)
                config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                config.queueDepth = 3; config.showsCursor = false; config.capturesAudio = false
                let next = SCStream(filter: filter, configuration: config, delegate: self)
                try next.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
                stream = next; try await next.startCapture()
                queue.async { self.emit(["type":"capture_started", "source":self.source]) }
                await MainActor.run { self.label.stringValue = "正在读取腾讯会议右侧实时转写。\n请保持转写面板展开；图像仅在本机识字，不保存。" }
                return
            }
            guard let display = content.displays.first else { throw NSError(domain: "MeetingBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "没有可用的显示器"] ) }
            let filter: SCContentFilter
            if source == "all" {
                filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
            } else {
                let apps = content.applications.filter { $0.bundleIdentifier == "com.tencent.meeting" || $0.bundleIdentifier.hasPrefix("com.tencent.meeting.") }
                guard !apps.isEmpty else { throw NSError(domain: "MeetingBridge", code: 2, userInfo: [NSLocalizedDescriptionKey: "请先打开腾讯会议，再从扩展点击开始。"] ) }
                filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
            }
            let config = SCStreamConfiguration()
            config.width = 2; config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.queueDepth = 3
            config.capturesAudio = true
            config.sampleRate = 48000
            config.channelCount = 2
            config.excludesCurrentProcessAudio = true
            config.showsCursor = false
            let next = SCStream(filter: filter, configuration: config, delegate: self)
            try next.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
            // No screen output is attached: screen images are neither consumed nor saved.
            stream = next
            try await next.startCapture()
            if stopping { try? await next.stopCapture(); return }
            queue.async { self.emit(["type": "capture_started", "source": self.source]) }
            await MainActor.run { self.label.stringValue = "正在监听。转写和问题显示在 Chrome 扩展中。\n此窗口可最小化；关闭窗口会停止采集。" }
        } catch {
            queue.async { self.emit(["type": "error", "message": error.localizedDescription]) }
            await MainActor.run { self.label.stringValue = "无法开始：\(error.localizedDescription)\n若刚授权，请停止后重新开始。" }
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.emit(["type": "error", "message": error.localizedDescription]) }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .screen && source == "tencent-text" { recognizeText(sampleBuffer); return }
        guard type == .audio, sampleBuffer.isValid, !stopping,
              let desc = sampleBuffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
              let format = AVAudioFormat(streamDescription: asbd) else { return }
        let bufferList = AudioBufferList.allocate(maximumBuffers: max(1, Int(format.channelCount)))
        defer { free(bufferList.unsafeMutablePointer) }
        var block: CMBlockBuffer?
        let code = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: bufferList.unsafeMutablePointer, bufferListSize: MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.size * max(0, Int(format.channelCount) - 1), blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &block)
        guard code == noErr,
              let input = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: bufferList.unsafePointer) else { return }
        input.frameLength = AVAudioFrameCount(sampleBuffer.numSamples)
        if sourceFormat != format { sourceFormat = format; converter = AVAudioConverter(from: format, to: targetFormat) }
        guard let converter, let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: AVAudioFrameCount(Double(input.frameLength) * 16000 / format.sampleRate + 64)) else { return }
        var delivered = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if delivered { status.pointee = .noDataNow; return nil }
            delivered = true; status.pointee = .haveData; return input
        }
        guard error == nil, output.frameLength > 0, let values = output.floatChannelData?[0] else { return }
        lastSample = Date()
        consume(Array(UnsafeBufferPointer(start: values, count: Int(output.frameLength))))
    }
    func recognizeText(_ sample: CMSampleBuffer) {
        guard !stopping, sample.isValid, Date().timeIntervalSince(lastOCR) >= 0.8, let pixel = sample.imageBuffer else { return }
        lastOCR = Date()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US", "zh-Hans"]
        request.usesLanguageCorrection = false
        // Only the right-hand transcription panel is passed to local text recognition.
        request.regionOfInterest = CGRect(x: 0.64, y: 0, width: 0.36, height: 1)
        do {
            try VNImageRequestHandler(cvPixelBuffer: pixel, options: [:]).perform([request])
            let lines: [[String:Any]] = (request.results ?? []).sorted { $0.boundingBox.midY > $1.boundingBox.midY }.compactMap { observation in
                guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.25 else { return nil }
                return ["text":candidate.string,"x":observation.boundingBox.minX,"y":observation.boundingBox.minY,"confidence":candidate.confidence]
            }
            emit(["type":"caption_frame","lines":lines])
        } catch { emit(["type":"error","message":"本机文字识别失败：\(error.localizedDescription)"]) }
    }
    func consume(_ values: [Float]) {
        var offset = 0
        while offset < values.count {
            let end = min(offset + 320, values.count)
            let block = Array(values[offset..<end]); offset = end
            let rms = sqrt(block.reduce(Float(0)) { $0 + $1 * $1 } / Float(block.count))
            let voiced = rms > 0.004
            if Date().timeIntervalSince(lastLevel) > 0.3 {
                lastLevel = Date()
                emit(["type": "level", "value": min(1, Double(rms) * 8)])
                DispatchQueue.main.async { self.level.doubleValue = min(1, Double(rms) * 8) }
            }
            if streamPCM {
                pcm.append(contentsOf: block.map { value in
                    Int16(max(-32768, min(32767, (value.isFinite ? value : 0) * 32768))).littleEndian
                })
                while pcm.count >= 1600 {
                    let frame = Array(pcm.prefix(1600)); pcm.removeFirst(1600)
                    emit(["type":"pcm", "data":frame.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()])
                }
                continue
            }
            if !active {
                preRoll.append(contentsOf: block)
                if preRoll.count > 4800 { preRoll.removeFirst(preRoll.count - 4800) }
                if voiced { active = true; speech = preRoll; preRoll.removeAll(); voicedFrames = block.count; quietFrames = 0; piece += 1; lastPreviewFrames = 0; lastVoiceAt = Date(); emit(["type": "speech_start"]) }
                continue
            }
            speech.append(contentsOf: block)
            if voiced { quietFrames = 0; voicedFrames += block.count; lastVoiceAt = Date() } else { quietFrames += block.count }
            if quietFrames >= 8800 { flush(final: true) }
            else if speech.count >= 240000 { flush(final: false) }
            else if speech.count - lastPreviewFrames >= 32000 && quietFrames == 0 {
                snapshot(partial: true, final: false)
                lastPreviewFrames = speech.count
            }
        }
    }
    func snapshot(partial: Bool, final: Bool) {
        if voicedFrames >= 3200 && speech.count >= 8000 {
            sequence += 1
            let filename = String(format: "audio-%08d.f32", sequence)
            let data = speech.withUnsafeBufferPointer { Data(buffer: $0) }
            do {
                try data.write(to: dir.appendingPathComponent(filename), options: .atomic)
                emit(["type": "segment", "file": filename, "final": final, "partial": partial, "piece": piece, "speechEndedAt": Int(lastVoiceAt.timeIntervalSince1970 * 1000), "duration": Double(speech.count) / 16000])
            } catch { emit(["type": "error", "message": error.localizedDescription]) }
        } else if final { emit(["type": "speech_end"]) }
    }
    func flush(final: Bool) {
        snapshot(partial: false, final: final)
        preRoll = Array(speech.suffix(3200))
        speech.removeAll(keepingCapacity: true); quietFrames = 0; voicedFrames = 0; lastPreviewFrames = 0; piece += 1
        active = !final
    }
    func stop() async {
        guard !stopping else { return }; stopping = true
        timer?.invalidate()
        try? await stream?.stopCapture()
        queue.sync {
            if streamPCM && !pcm.isEmpty {
                emit(["type":"pcm", "data":pcm.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()])
                pcm.removeAll()
            }
            emit(["type": "capture_stopped"])
        }
        await MainActor.run { NSApplication.shared.terminate(nil) }
    }
}

func argument(_ name: String, fallback: String = "") -> String {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return fallback }
    return CommandLine.arguments[index + 1]
}
let sessionPath = argument("--session")
guard !sessionPath.isEmpty else { fputs("Launch this helper from the Meeting Bridge Chrome extension.\n", stderr); exit(1) }
let app = NSApplication.shared
let capture = Capture(dir: URL(fileURLWithPath: sessionPath), source: argument("--source", fallback: "all"), parentPID: pid_t(argument("--parent", fallback: "0")) ?? 0, streamPCM: argument("--stream-pcm") == "1", background: argument("--background") == "1")
capture.showWindow()
Task { await capture.start() }
app.run()
