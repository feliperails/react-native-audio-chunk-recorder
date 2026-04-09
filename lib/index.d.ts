/**
 * react-native-audio-chunk-recorder
 * Main entry point for the NPM module
 */
export { useAudioRecorderCore } from "./hooks/useAudioRecorderCore";
export { useAudioLevel } from "./hooks/useAudioLevel";
export { createJotaiStateManager } from "./adapters/jotaiAdapter";
export { audioManager } from "./providers/audioManager";
export type { AudioRecorderCoreOptions, AudioRecorderCoreReturn, ChunkData, ErrorData, InterruptionData, StateChangeData, AudioLevelData, RecordingOptions, StateManager, AlertProvider, InterruptionHandler, ChunkUploader, } from "./types";
export type { UseAudioLevelOptions, UseAudioLevelReturn, } from "./hooks/useAudioLevel";
export { NativeAudioChunkRecorder, AudioChunkRecorderEventEmitter, } from "./NativeAudioChunkRecorder";
export { reactNativeAlertProvider } from "./providers/reactNativeAlertProvider";
export { createSimpleStateManager } from "./providers/simpleStateManager";
export { noopErrorTracker, createSentryErrorTracker, createConsoleErrorTracker, } from "./providers/errorTracker";
export type { ErrorTracker } from "./providers/errorTracker";
