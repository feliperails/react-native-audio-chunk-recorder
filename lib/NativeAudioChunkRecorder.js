"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AudioChunkRecorderEventEmitter = exports.NativeAudioChunkRecorder = void 0;
const react_native_1 = require("react-native");
const { AudioChunkRecorder } = react_native_1.NativeModules;
if (!AudioChunkRecorder) {
    throw new Error("AudioChunkRecorder native module is not available. Make sure you have properly installed and linked the react-native-audio-chunk-recorder package.");
}
exports.NativeAudioChunkRecorder = AudioChunkRecorder;
// Event emitter for native events
exports.AudioChunkRecorderEventEmitter = new react_native_1.NativeEventEmitter(AudioChunkRecorder);
