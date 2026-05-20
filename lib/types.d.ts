/**
 * Core types and interfaces for react-native-audio-chunk-recorder
 */
import { ErrorTracker } from "./providers/errorTracker";
export interface ChunkData {
    path: string;
    sequence: number;
    timestamp?: number;
    size?: number;
    isLastChunk?: boolean;
}
export declare const getChunkUri: (chunk: ChunkData) => string;
export interface RecordingOptions {
    sampleRate?: number;
    bitRate?: number;
    chunkSeconds?: number;
    maxRecordingDuration?: number;
}
export type AudioChunkRecorderOptions = RecordingOptions;
export type AudioChunk = ChunkData;
export interface ErrorData {
    message: string;
    code?: number;
}
export interface InterruptionData {
    type: "began" | "ended" | "audioDeviceDisconnected";
    reason?: string;
    wasRecording?: boolean;
    shouldResume?: boolean;
    canResume?: boolean;
    nativePaused?: boolean;
}
export interface StateChangeData {
    isRecording: boolean;
    isPaused: boolean;
}
export interface MaxDurationReachedData {
    duration: number;
    maxDuration: number;
    chunks: ChunkData[];
}
export interface FullRecordingData {
    path: string;
    timestamp: number;
    size: number;
    durationSeconds: number;
}
export interface AudioLevelData {
    level: number;
    hasAudio: boolean;
    averagePower?: number;
}
export interface AlertButton {
    text: string;
    onPress?: () => void;
    style?: "default" | "cancel" | "destructive";
}
export interface AlertProvider {
    showAlert: (title: string, message: string, buttons: AlertButton[]) => void;
}
export interface StateManager {
    getState: <T>(key: string) => T;
    setState: <T>(key: string, value: T) => void;
    subscribe: <T>(key: string, callback: (value: T) => void) => () => void;
}
export interface InterruptionHandler {
    onInterruption: (data: InterruptionData) => void;
    onDeviceDisconnected: (data: InterruptionData) => void;
}
export interface ChunkUploader {
    upload: (chunk: ChunkData) => Promise<void>;
    onProgress?: (progress: number) => void;
    onSuccess?: (chunkId: string) => void;
    onError?: (chunkId: string, error: string) => void;
}
export interface AudioRecorderCoreOptions {
    alertProvider?: AlertProvider;
    stateManager?: StateManager;
    interruptionHandler?: InterruptionHandler;
    chunkUploader?: ChunkUploader;
    errorTracker?: ErrorTracker;
    nativeService?: any;
    autoStartRecording?: boolean;
    autoCheckPermissions?: boolean;
    defaultRecordingOptions?: RecordingOptions;
    onChunkReady?: (chunk: ChunkData) => void;
    onError?: (error: ErrorData) => void;
    onInterruption?: (interruption: InterruptionData) => void;
    onStateChange?: (state: StateChangeData) => void;
    onMaxDurationReached?: (data: MaxDurationReachedData) => void;
    onFullRecordingReady?: (data: FullRecordingData) => void;
}
export interface AudioRecorderCoreReturn {
    service: any | null;
    isRecording: boolean;
    isPaused: boolean;
    hasPermission: boolean;
    chunks: ChunkData[];
    audioLevel: number;
    hasAudio: boolean;
    isAvailable: boolean;
    isInterrupted: boolean;
    recordingDuration: number;
    maxRecordingDuration: number;
    remainingDuration: number;
    queueSize?: number;
    isUploading?: boolean;
    startRecording: (options?: RecordingOptions) => Promise<void>;
    stopRecording: () => Promise<void>;
    pauseRecording: () => Promise<void>;
    resumeRecording: () => Promise<void>;
    clearChunks: () => void;
    clearAllChunkFiles: () => Promise<void>;
    checkPermissions: () => Promise<void>;
    getExpectedChunkDuration: () => number;
    onChunkReady: (callback: (chunk: ChunkData) => void) => () => void;
    onAudioLevel: (callback: (levelData: AudioLevelData) => void) => () => void;
    onError: (callback: (error: ErrorData) => void) => () => void;
    onInterruption: (callback: (interruption: InterruptionData) => void) => () => void;
    onStateChange: (callback: (state: StateChangeData) => void) => () => void;
    onMaxDurationReached: (callback: (data: MaxDurationReachedData) => void) => () => void;
    onFullRecordingReady: (callback: (data: FullRecordingData) => void) => () => void;
}
