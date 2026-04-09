"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAudioLevel = useAudioLevel;
const react_1 = require("react");
const NativeAudioChunkRecorder_1 = require("../NativeAudioChunkRecorder");
const audioManager_1 = require("../providers/audioManager");
const errorTracker_1 = require("../providers/errorTracker");
// Optimized event listener manager for audio level only
class AudioLevelEventListenerManager {
    constructor() {
        this.listeners = {
            onAudioLevel: new Set(),
            onError: new Set(),
        };
        this.nativeListeners = [];
        this.lastAudioLevelUpdate = 0;
    }
    addListener(event, callback) {
        this.listeners[event].add(callback);
    }
    removeListener(event, callback) {
        this.listeners[event].delete(callback);
    }
    notifyListeners(event, data) {
        this.listeners[event].forEach((listener) => {
            try {
                listener(data);
            }
            catch (error) {
                console.error(`useAudioLevel: Error in ${event} listener:`, error);
            }
        });
    }
    setupNativeListeners(options, updateState) {
        // Clear existing listeners
        this.cleanup();
        // Audio level listener with throttling
        const levelListener = NativeAudioChunkRecorder_1.AudioChunkRecorderEventEmitter.addListener("onAudioLevel", (data) => {
            // Call the handleAudioLevel function instead of directly updating state
            this.handleAudioLevel(data, options, updateState);
            this.notifyListeners("onAudioLevel", data);
        });
        // Error listener
        const errorListener = NativeAudioChunkRecorder_1.AudioChunkRecorderEventEmitter.addListener("onError", (error) => {
            var _a;
            this.notifyListeners("onError", error);
            (_a = options.onError) === null || _a === void 0 ? void 0 : _a.call(options, error);
        });
        this.nativeListeners = [levelListener, errorListener];
    }
    handleAudioLevel(levelData, options, updateState) {
        var _a;
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastAudioLevelUpdate;
        if (!options.disableThrottling &&
            !options.debug &&
            timeSinceLastUpdate < (options.throttleMs || 100)) {
            return; // Throttle updates
        }
        // Use native values directly without any processing
        const nativeLevel = levelData.level;
        const nativeHasAudio = levelData.hasAudio;
        const newData = {
            level: nativeLevel,
            hasAudio: nativeHasAudio,
        };
        // Update state with native values
        updateState({ audioLevel: nativeLevel, hasAudio: nativeHasAudio });
        // Call level change callback
        (_a = options.onLevelChange) === null || _a === void 0 ? void 0 : _a.call(options, newData);
    }
    cleanup() {
        this.nativeListeners.forEach((listener) => {
            if (listener && typeof listener.remove === "function") {
                listener.remove();
            }
        });
        this.nativeListeners = [];
    }
}
/**
 * useAudioLevel - Specialized hook for audio level monitoring only
 *
 * This hook follows the same pattern as useAudioRecorderCore but is optimized
 * specifically for audio level monitoring. It uses the recording pipeline
 * with very short chunks (< 1 second) to avoid file creation.
 */
function useAudioLevel(options = {}) {
    const { autoStart = false } = options;
    // Local state with optimized updates
    const [state, setState] = (0, react_1.useState)({
        audioLevel: 0,
        hasAudio: false,
        isMonitoring: false,
        error: undefined,
    });
    // Event listener manager - singleton instance
    const eventManagerRef = (0, react_1.useRef)(null);
    if (!eventManagerRef.current) {
        eventManagerRef.current = new AudioLevelEventListenerManager();
    }
    // Service ref
    const serviceRef = (0, react_1.useRef)(null);
    // Auto start tracking
    const autoStartAttemptedRef = (0, react_1.useRef)(false);
    // Track previous audio state for detection callbacks
    const previousHasAudioRef = (0, react_1.useRef)(false);
    // Memoized state setters to prevent unnecessary re-renders
    const updateState = (0, react_1.useCallback)((updates) => {
        setState((prev) => ({ ...prev, ...updates }));
    }, []);
    // Error tracker - use provided or fallback to no-op
    const errorTracker = (0, react_1.useMemo)(() => options.errorTracker || errorTracker_1.noopErrorTracker, [options.errorTracker]);
    // Initialize service - only once
    (0, react_1.useEffect)(() => {
        try {
            serviceRef.current = NativeAudioChunkRecorder_1.NativeAudioChunkRecorder;
            NativeAudioChunkRecorder_1.NativeAudioChunkRecorder.isAvailable()
                .then((available) => {
                if (!available) {
                    setState((prev) => ({ ...prev, error: "Service not available" }));
                }
            })
                .catch((error) => {
                console.error("useAudioLevel: Failed to check availability:", error);
                setState((prev) => ({ ...prev, error: "Service not available" }));
            });
        }
        catch (error) {
            console.error("useAudioLevel: Failed to initialize service:", error);
            setState((prev) => ({ ...prev, error: "Service not available" }));
        }
    }, []); // Empty dependency array - only run once
    // Setup native event listeners - optimized dependencies
    (0, react_1.useEffect)(() => {
        if (!serviceRef.current)
            return;
        eventManagerRef.current.setupNativeListeners(options, updateState);
        return () => {
            eventManagerRef.current.cleanup();
        };
    }, [
        options.onLevelChange,
        options.onAudioDetected,
        options.onAudioLost,
        options.onError,
        options.throttleMs,
        options.disableThrottling,
        updateState,
    ]);
    // Memoized actions to prevent unnecessary re-creation
    const startMonitoring = (0, react_1.useCallback)(async () => {
        // Check if already monitoring to avoid conflicts
        if (state.isMonitoring) {
            return;
        }
        try {
            updateState({ error: undefined });
            errorTracker.addBreadcrumb({
                message: "Starting audio level monitoring",
                category: "audio_monitoring",
                level: "info",
            });
            // Use AudioManager to start monitoring
            const result = await audioManager_1.audioManager.startMonitoring({
                sampleRate: 16000,
                chunkSeconds: 0.1, // Less than 1s = no file saving
            });
            updateState({ isMonitoring: true });
        }
        catch (error) {
            updateState({ error: `Failed to start monitoring: ${error}` });
            errorTracker.captureException(error, {
                action: "start_monitoring",
            });
            throw error;
        }
    }, [state.isMonitoring, updateState, errorTracker]);
    const stopMonitoring = (0, react_1.useCallback)(async () => {
        try {
            errorTracker.addBreadcrumb({
                message: "Stopping audio level monitoring",
                category: "audio_monitoring",
                level: "info",
            });
            await audioManager_1.audioManager.stopMonitoring();
            // Reset state
            updateState({
                isMonitoring: false,
                audioLevel: 0,
                hasAudio: false,
                error: undefined,
            });
        }
        catch (error) {
            updateState({ error: `Failed to stop monitoring: ${error}` });
            errorTracker.captureException(error, {
                action: "stop_monitoring",
            });
            throw error;
        }
    }, [updateState, errorTracker]);
    // Auto start monitoring when conditions are met
    (0, react_1.useEffect)(() => {
        if (autoStart &&
            !state.isMonitoring &&
            !autoStartAttemptedRef.current &&
            serviceRef.current) {
            autoStartAttemptedRef.current = true;
            startMonitoring().catch((error) => {
                // Reset flag on error so it can try again
                autoStartAttemptedRef.current = false;
            });
        }
    }, [autoStart, state.isMonitoring, startMonitoring]);
    // Listen to AudioManager state changes
    (0, react_1.useEffect)(() => {
        const unsubscribe = audioManager_1.audioManager.addListener((type, active) => {
            if (type === "monitoring") {
                if (!active && state.isMonitoring) {
                    // Monitoring was stopped by another hook or the manager
                    updateState({
                        isMonitoring: false,
                        audioLevel: 0,
                        hasAudio: false,
                        error: undefined,
                    });
                }
            }
        });
        return unsubscribe;
    }, [state.isMonitoring, updateState]);
    // Handle audio detection/loss callbacks
    (0, react_1.useEffect)(() => {
        const wasAudio = previousHasAudioRef.current;
        const isAudio = state.hasAudio;
        // Only call callbacks on state transitions
        if (isAudio && !wasAudio && options.onAudioDetected) {
            options.onAudioDetected(state.audioLevel);
        }
        else if (!isAudio && wasAudio && options.onAudioLost) {
            options.onAudioLost();
        }
        // Update previous state reference
        previousHasAudioRef.current = isAudio;
    }, [
        state.hasAudio,
        state.audioLevel,
        options.onAudioDetected,
        options.onAudioLost,
    ]);
    // Debug method to check AudioRecord state
    const getAudioRecordState = (0, react_1.useCallback)(async () => {
        if (!serviceRef.current) {
            return "Service not available";
        }
        try {
            const state = await serviceRef.current.getAudioRecordState();
            return state;
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error("useAudioLevel: Failed to get AudioRecord state:", err);
            return errorMessage;
        }
    }, []);
    // Memoized return object to prevent unnecessary re-renders
    const returnValue = (0, react_1.useMemo)(() => ({
        // State
        data: {
            level: state.audioLevel,
            hasAudio: state.hasAudio,
        },
        isMonitoring: state.isMonitoring,
        error: state.error,
        // Actions
        startMonitoring,
        stopMonitoring,
        // Debug
        getAudioRecordState,
    }), [
        state.audioLevel,
        state.hasAudio,
        state.isMonitoring,
        state.error,
        startMonitoring,
        stopMonitoring,
        getAudioRecordState,
    ]);
    return returnValue;
}
