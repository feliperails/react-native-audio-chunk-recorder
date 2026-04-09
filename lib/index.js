"use strict";
/**
 * react-native-audio-chunk-recorder
 * Main entry point for the NPM module
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConsoleErrorTracker = exports.createSentryErrorTracker = exports.noopErrorTracker = exports.createSimpleStateManager = exports.reactNativeAlertProvider = exports.AudioChunkRecorderEventEmitter = exports.NativeAudioChunkRecorder = exports.audioManager = exports.createJotaiStateManager = exports.useAudioLevel = exports.useAudioRecorderCore = void 0;
// Main hooks
var useAudioRecorderCore_1 = require("./hooks/useAudioRecorderCore");
Object.defineProperty(exports, "useAudioRecorderCore", { enumerable: true, get: function () { return useAudioRecorderCore_1.useAudioRecorderCore; } });
var useAudioLevel_1 = require("./hooks/useAudioLevel");
Object.defineProperty(exports, "useAudioLevel", { enumerable: true, get: function () { return useAudioLevel_1.useAudioLevel; } });
var jotaiAdapter_1 = require("./adapters/jotaiAdapter");
Object.defineProperty(exports, "createJotaiStateManager", { enumerable: true, get: function () { return jotaiAdapter_1.createJotaiStateManager; } });
var audioManager_1 = require("./providers/audioManager");
Object.defineProperty(exports, "audioManager", { enumerable: true, get: function () { return audioManager_1.audioManager; } });
// Native module
var NativeAudioChunkRecorder_1 = require("./NativeAudioChunkRecorder");
Object.defineProperty(exports, "NativeAudioChunkRecorder", { enumerable: true, get: function () { return NativeAudioChunkRecorder_1.NativeAudioChunkRecorder; } });
Object.defineProperty(exports, "AudioChunkRecorderEventEmitter", { enumerable: true, get: function () { return NativeAudioChunkRecorder_1.AudioChunkRecorderEventEmitter; } });
// Default providers
var reactNativeAlertProvider_1 = require("./providers/reactNativeAlertProvider");
Object.defineProperty(exports, "reactNativeAlertProvider", { enumerable: true, get: function () { return reactNativeAlertProvider_1.reactNativeAlertProvider; } });
var simpleStateManager_1 = require("./providers/simpleStateManager");
Object.defineProperty(exports, "createSimpleStateManager", { enumerable: true, get: function () { return simpleStateManager_1.createSimpleStateManager; } });
// Error tracking
var errorTracker_1 = require("./providers/errorTracker");
Object.defineProperty(exports, "noopErrorTracker", { enumerable: true, get: function () { return errorTracker_1.noopErrorTracker; } });
Object.defineProperty(exports, "createSentryErrorTracker", { enumerable: true, get: function () { return errorTracker_1.createSentryErrorTracker; } });
Object.defineProperty(exports, "createConsoleErrorTracker", { enumerable: true, get: function () { return errorTracker_1.createConsoleErrorTracker; } });
