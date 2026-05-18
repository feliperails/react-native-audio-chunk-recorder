export type AudioActivityType = "recording" | "monitoring";
export interface AudioManagerListener {
    (type: AudioActivityType, active: boolean): void;
}
/**
 * Global Audio Manager - Coordinates all audio hooks to prevent conflicts
 *
 * This manager ensures that only one audio activity (recording or monitoring)
 * can be active at a time, preventing "Recording is already in progress" errors.
 */
declare class AudioManager {
    private static instance;
    private isRecording;
    private isMonitoring;
    private listeners;
    private nativeService;
    private initializationPromise;
    private constructor();
    private subscribeToNativeStateChanges;
    static getInstance(): AudioManager;
    private initializeNativeService;
    private ensureInitialized;
    /**
     * Start recording - will stop monitoring if active
     */
    startRecording(options?: any): Promise<string>;
    /**
     * Start monitoring - will fail if recording is active
     */
    startMonitoring(options?: any): Promise<string>;
    /**
     * Stop recording
     */
    stopRecording(): Promise<string>;
    /**
     * Stop monitoring
     */
    stopMonitoring(): Promise<string>;
    /**
     * Get current state
     */
    getState(): {
        isRecording: boolean;
        isMonitoring: boolean;
        hasActiveAudio: boolean;
    };
    /**
     * Add listener for state changes
     */
    addListener(listener: AudioManagerListener): () => void;
    /**
     * Notify all listeners of state changes
     */
    private notifyListeners;
    /**
     * Force stop all audio activities
     */
    forceStopAll(): Promise<void>;
    /**
     * Cleanup - call when app is shutting down
     */
    cleanup(): void;
}
export declare const audioManager: AudioManager;
export {};
