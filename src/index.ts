/**
 * react-native-audio-chunk-recorder
 * Main entry point for the NPM module
 */

// Main hooks
export { useAudioRecorderCore } from "./hooks/useAudioRecorderCore";
export { useAudioLevel } from "./hooks/useAudioLevel";

export { createJotaiStateManager } from "./adapters/jotaiAdapter";
export { audioManager } from "./providers/audioManager";

// Types
export type {
  AudioRecorderCoreOptions,
  AudioRecorderCoreReturn,
  ChunkData,
  FullRecordingData,
  MaxDurationReachedData,
  ErrorData,
  InterruptionData,
  StateChangeData,
  AudioLevelData,
  RecordingOptions,
  StateManager,
  AlertProvider,
  InterruptionHandler,
  ChunkUploader,
} from "./types";

// Export types from useAudioLevel
export type {
  UseAudioLevelOptions,
  UseAudioLevelReturn,
} from "./hooks/useAudioLevel";

// Native module
export {
  NativeAudioChunkRecorder,
  AudioChunkRecorderEventEmitter,
} from "./NativeAudioChunkRecorder";

// Default providers
export { reactNativeAlertProvider } from "./providers/reactNativeAlertProvider";
export { createSimpleStateManager } from "./providers/simpleStateManager";

// Error tracking
export {
  noopErrorTracker,
  createSentryErrorTracker,
  createConsoleErrorTracker,
} from "./providers/errorTracker";
export type { ErrorTracker } from "./providers/errorTracker";
