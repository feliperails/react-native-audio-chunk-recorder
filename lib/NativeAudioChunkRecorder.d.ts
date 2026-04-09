import { NativeEventEmitter } from "react-native";
import type { RecordingOptions, ChunkData, ErrorData, StateChangeData, AudioLevelData, InterruptionData } from "./types";
export interface NativeAudioChunkRecorderInterface {
    startRecording(options: RecordingOptions): Promise<string>;
    stopRecording(): Promise<string>;
    pauseRecording(): Promise<string>;
    resumeRecording(): Promise<string>;
    startAudioLevelPreview(): Promise<void>;
    stopAudioLevelPreview(): Promise<void>;
    checkPermissions(): Promise<boolean>;
    isAvailable(): Promise<boolean>;
    getAudioRecordState(): Promise<string>;
    clearAllChunkFiles(): Promise<string>;
}
export declare const NativeAudioChunkRecorder: NativeAudioChunkRecorderInterface;
export declare const AudioChunkRecorderEventEmitter: NativeEventEmitter;
export interface AudioChunkRecorderEvents {
    onChunkReady: (chunk: ChunkData) => void;
    onError: (error: ErrorData) => void;
    onStateChange: (state: StateChangeData) => void;
    onAudioLevel: (levelData: AudioLevelData) => void;
    onInterruption: (interruption: InterruptionData) => void;
}
export type AudioChunkRecorderEventType = keyof AudioChunkRecorderEvents;
