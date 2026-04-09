export interface AudioLevelData {
    level: number;
    hasAudio: boolean;
}
export interface UseAudioLevelOptions {
    /** Throttle audio level updates in milliseconds (default: 100) */
    throttleMs?: number;
    /** Disable throttling completely for debugging (default: false) */
    disableThrottling?: boolean;
    /** Debug mode - logs all native updates and disables throttling (default: false) */
    debug?: boolean;
    /** Callback when audio level changes */
    onLevelChange?: (data: AudioLevelData) => void;
    /** Callback when audio is detected */
    onAudioDetected?: (level: number) => void;
    /** Callback when audio is lost */
    onAudioLost?: () => void;
    /** Callback when an error occurs */
    onError?: (error: any) => void;
    /** Auto-start monitoring when hook mounts */
    autoStart?: boolean;
    /** Error tracker for monitoring errors */
    errorTracker?: any;
}
export interface UseAudioLevelReturn {
    /** Current audio level data */
    data: AudioLevelData;
    /** Start audio level monitoring */
    startMonitoring: () => Promise<void>;
    /** Stop audio level monitoring */
    stopMonitoring: () => Promise<void>;
    /** Whether monitoring is currently active */
    isMonitoring: boolean;
    /** Error message if any */
    error?: string;
    /** Debug method to check AudioRecord state */
    getAudioRecordState: () => Promise<string>;
}
/**
 * useAudioLevel - Specialized hook for audio level monitoring only
 *
 * This hook follows the same pattern as useAudioRecorderCore but is optimized
 * specifically for audio level monitoring. It uses the recording pipeline
 * with very short chunks (< 1 second) to avoid file creation.
 */
export declare function useAudioLevel(options?: UseAudioLevelOptions): UseAudioLevelReturn;
