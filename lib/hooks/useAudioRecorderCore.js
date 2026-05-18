"use strict";
/**
 * Core audio recorder hook - modular and framework-agnostic
 * This is the main hook that would be part of the NPM module
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.useAudioRecorderCore = void 0;
const react_1 = require("react");
const NativeAudioChunkRecorder_1 = require("../NativeAudioChunkRecorder");
const reactNativeAlertProvider_1 = require("../providers/reactNativeAlertProvider");
const simpleStateManager_1 = require("../providers/simpleStateManager");
const audioManager_1 = require("../providers/audioManager");
const errorTracker_1 = require("../providers/errorTracker");
// Performance constants
const AUDIO_LEVEL_THROTTLE_MS = 100; // Throttle audio level updates
const STATE_UPDATE_DEBOUNCE_MS = 50; // Debounce state updates
// Optimized event listener manager
class EventListenerManager {
    constructor() {
        this.listeners = {
            onChunkReady: new Set(),
            onAudioLevel: new Set(),
            onError: new Set(),
            onInterruption: new Set(),
            onStateChange: new Set(),
            onMaxDurationReached: new Set(),
        };
        this.nativeListeners = [];
        this.lastAudioLevelUpdate = 0;
        this.stateUpdateTimeout = null;
    }
    addListener(event, callback) {
        this.listeners[event].add(callback);
    }
    removeListener(event, callback) {
        this.listeners[event].delete(callback);
    }
    notifyListeners(event, data) {
        // Throttle audio level updates for performance
        if (event === "onAudioLevel") {
            const now = Date.now();
            if (now - this.lastAudioLevelUpdate < AUDIO_LEVEL_THROTTLE_MS) {
                return;
            }
            this.lastAudioLevelUpdate = now;
        }
        this.listeners[event].forEach((listener) => {
            try {
                listener(data);
            }
            catch (error) {
                console.error(`AudioRecorderCore: Error in ${event} listener:`, error);
            }
        });
    }
    setupNativeListeners(options, stateManager, alertProvider, errorTracker, updateState, updateAudioLevel) {
        // Clear existing listeners
        this.cleanup();
        // Chunk ready listener with low priority to avoid interfering with audio level
        const chunkListener = NativeAudioChunkRecorder_1.AudioChunkRecorderEventEmitter.addListener("onChunkReady", (chunk) => {
            // Use setTimeout to defer chunk processing and avoid blocking audio level updates
            setTimeout(() => {
                var _a;
                this.notifyListeners("onChunkReady", chunk);
                (_a = options.onChunkReady) === null || _a === void 0 ? void 0 : _a.call(options, chunk);
                // Upload chunk if uploader is provided
                if (options.chunkUploader) {
                    options.chunkUploader.upload(chunk).catch((error) => {
                        var _a, _b;
                        console.error("AudioRecorderCore: Chunk upload failed:", error);
                        errorTracker.captureException(error, {
                            chunk: chunk,
                            action: "chunk_upload",
                            chunkSeq: chunk.sequence,
                        });
                        (_b = (_a = options.chunkUploader) === null || _a === void 0 ? void 0 : _a.onError) === null || _b === void 0 ? void 0 : _b.call(_a, chunk.sequence.toString(), error.message || "Upload failed");
                    });
                }
            }, 0); // Defer to next tick to prioritize audio level
        });
        // Audio level listener with optimized high-priority handling
        const levelListener = NativeAudioChunkRecorder_1.AudioChunkRecorderEventEmitter.addListener("onAudioLevel", (data) => {
            // Update audio level using optimized function to prevent main state rerenders
            // This now has higher priority to maintain smooth animations
            updateAudioLevel(data.level, data.hasAudio);
            this.notifyListeners("onAudioLevel", data);
        });
        // Error listener
        const errorListener = NativeAudioChunkRecorder_1.AudioChunkRecorderEventEmitter.addListener("onError", (error) => {
            var _a;
            console.error("AudioRecorderCore: Native error:", error);
            errorTracker.captureException(new Error(error.message), {
                errorCode: error.code,
                source: "native_module",
            });
            this.notifyListeners("onError", error);
            (_a = options.onError) === null || _a === void 0 ? void 0 : _a.call(options, error);
        });
        // State change listener with debouncing
        const stateListener = NativeAudioChunkRecorder_1.AudioChunkRecorderEventEmitter.addListener("onStateChange", (state) => {
            // Update state directly for recording state
            updateState({
                isRecording: state.isRecording,
                isPaused: state.isPaused,
            });
            // Debounce state updates to prevent excessive re-renders
            if (this.stateUpdateTimeout) {
                clearTimeout(this.stateUpdateTimeout);
            }
            this.stateUpdateTimeout = setTimeout(() => {
                var _a;
                this.notifyListeners("onStateChange", state);
                (_a = options.onStateChange) === null || _a === void 0 ? void 0 : _a.call(options, state);
            }, STATE_UPDATE_DEBOUNCE_MS);
        });
        // Interruption listener
        const interruptionListener = NativeAudioChunkRecorder_1.AudioChunkRecorderEventEmitter.addListener("onInterruption", (interruption) => {
            var _a;
            this.notifyListeners("onInterruption", interruption);
            // Add breadcrumb for interruption
            errorTracker.addBreadcrumb({
                message: `Audio interruption: ${interruption.type}`,
                category: "audio_interruption",
                level: "warning",
                data: interruption,
            });
            // Update global state
            if (interruption.type === "began") {
                updateState({ isInterrupted: true });
                stateManager.setState("audioInterruption", true);
            }
            else if (interruption.type === "ended") {
                updateState({ isInterrupted: false });
                stateManager.setState("audioInterruption", false);
            }
            // Handle interruption with custom handler or default behavior
            if (options.interruptionHandler) {
                if (interruption.type === "audioDeviceDisconnected") {
                    options.interruptionHandler.onDeviceDisconnected(interruption);
                }
                else {
                    options.interruptionHandler.onInterruption(interruption);
                }
            }
            else {
                // Default interruption handling
                this.handleInterruptionDefault(interruption, alertProvider);
            }
            (_a = options.onInterruption) === null || _a === void 0 ? void 0 : _a.call(options, interruption);
        });
        this.nativeListeners = [
            chunkListener,
            levelListener,
            errorListener,
            stateListener,
            interruptionListener,
        ];
    }
    handleInterruptionDefault(interruption, alertProvider) {
        if (interruption.type === "began") {
            alertProvider.showAlert("Call in Progress", "Recording paused due to incoming call. Recording will resume when the call ends.", [{ text: "OK" }]);
        }
        else if (interruption.type === "audioDeviceDisconnected") {
            alertProvider.showAlert("Audio Device Disconnected", "Your audio device was disconnected. Please reconnect and try again.", [{ text: "OK" }]);
        }
    }
    cleanup() {
        this.nativeListeners.forEach((listener) => {
            if (listener && typeof listener.remove === "function") {
                listener.remove();
            }
        });
        this.nativeListeners = [];
        if (this.stateUpdateTimeout) {
            clearTimeout(this.stateUpdateTimeout);
            this.stateUpdateTimeout = null;
        }
    }
}
const useAudioRecorderCore = (options = {}) => {
    var _a;
    // Use provided dependencies or defaults - memoized to prevent re-creation
    const alertProvider = (0, react_1.useMemo)(() => options.alertProvider || reactNativeAlertProvider_1.reactNativeAlertProvider, [options.alertProvider]);
    const stateManager = (0, react_1.useMemo)(() => options.stateManager || (0, simpleStateManager_1.createSimpleStateManager)(), [options.stateManager]);
    const errorTracker = (0, react_1.useMemo)(() => options.errorTracker || errorTracker_1.noopErrorTracker, [options.errorTracker]);
    // Optimized state management - separate frequently changing values
    const [state, setState] = (0, react_1.useState)({
        isRecording: false,
        isPaused: false,
        hasPermission: false,
        chunks: [],
        isAvailable: false,
        isInterrupted: false,
        recordingDuration: 0,
        maxRecordingDuration: 7200, // 2 hours default
        isAudioManagerReady: false, // Track AudioManager initialization
    });
    // Separate state for frequently changing values to prevent rerenders
    const [audioLevel, setAudioLevel] = (0, react_1.useState)(0);
    const [hasAudio, setHasAudio] = (0, react_1.useState)(false);
    // Recording duration tracking
    const recordingStartTimeRef = (0, react_1.useRef)(null);
    const pausedTimeRef = (0, react_1.useRef)(0);
    const durationIntervalRef = (0, react_1.useRef)(null);
    // Latched once we fire onMaxDurationReached for a session, cleared on the
    // next startRecording. Prevents the duration-tracking effect from
    // re-triggering when consumers pass a fresh `options.onMaxDurationReached`
    // callback every render (which causes the effect to re-run, re-create the
    // interval, and read a stale recordingStartTimeRef).
    const maxDurationFiredRef = (0, react_1.useRef)(false);
    // Stash the consumer's onMaxDurationReached so the duration-tracking
    // effect doesn't need it in its dep array. Listing it there caused the
    // effect to thrash whenever the consumer re-rendered with a fresh callback.
    const onMaxDurationReachedRef = (0, react_1.useRef)(options.onMaxDurationReached);
    onMaxDurationReachedRef.current = options.onMaxDurationReached;
    // Event listener manager - singleton instance
    const eventManagerRef = (0, react_1.useRef)(null);
    if (!eventManagerRef.current) {
        eventManagerRef.current = new EventListenerManager();
    }
    // Service ref
    const serviceRef = (0, react_1.useRef)(null);
    // Auto start tracking
    const autoStartAttemptedRef = (0, react_1.useRef)(false);
    // Refs for frequently accessed values to prevent unnecessary effect re-runs
    const chunksRef = (0, react_1.useRef)([]);
    const isRecordingRef = (0, react_1.useRef)(false);
    const isPausedRef = (0, react_1.useRef)(false);
    // Update refs when state changes
    (0, react_1.useEffect)(() => {
        chunksRef.current = state.chunks;
        isRecordingRef.current = state.isRecording;
        isPausedRef.current = state.isPaused;
    }, [state.chunks, state.isRecording, state.isPaused]);
    // Memoized state setters to prevent unnecessary re-renders
    const updateState = (0, react_1.useCallback)((updates) => {
        setState((prev) => ({ ...prev, ...updates }));
    }, []);
    // Optimized audio level update - doesn't trigger main state updates
    const updateAudioLevel = (0, react_1.useCallback)((level, hasAudio) => {
        setAudioLevel(level);
        setHasAudio(hasAudio);
    }, []);
    // Initialize service - only once
    (0, react_1.useEffect)(() => {
        console.log("AudioRecorderCore: 🔄 Initializing native service...");
        try {
            serviceRef.current = NativeAudioChunkRecorder_1.NativeAudioChunkRecorder;
            NativeAudioChunkRecorder_1.NativeAudioChunkRecorder.isAvailable()
                .then((available) => {
                console.log("AudioRecorderCore: ✅ Native service available:", available);
                updateState({ isAvailable: available });
            })
                .catch((error) => {
                console.error("AudioRecorderCore: Failed to check availability:", error);
                updateState({ isAvailable: false });
            });
        }
        catch (error) {
            console.error("AudioRecorderCore: Failed to initialize service:", error);
            updateState({ isAvailable: false });
        }
    }, [updateState]); // Add updateState to dependencies
    // Wait for AudioManager to be ready after service is available
    (0, react_1.useEffect)(() => {
        if (state.isAvailable && !state.isAudioManagerReady) {
            console.log("AudioRecorderCore: 🔄 Waiting for AudioManager to be ready...");
            // Give AudioManager time to initialize
            const initTimeout = setTimeout(async () => {
                try {
                    // Test the AudioManager with a simple operation
                    const managerState = audioManager_1.audioManager.getState();
                    console.log("AudioRecorderCore: AudioManager state:", managerState);
                    // Additional check - try to access the native service through AudioManager
                    // This ensures the initialization promise has resolved
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    updateState({ isAudioManagerReady: true });
                    console.log("AudioRecorderCore: ✅ AudioManager is ready for auto-start");
                }
                catch (error) {
                    console.error("AudioRecorderCore: AudioManager not ready:", error);
                    // Retry after a longer delay
                    setTimeout(() => {
                        if (!state.isAudioManagerReady) {
                            console.log("AudioRecorderCore: 🔄 Retrying AudioManager initialization...");
                            updateState({ isAudioManagerReady: false });
                        }
                    }, 2000);
                }
            }, 1000); // Wait 1 second for AudioManager to initialize
            return () => {
                clearTimeout(initTimeout);
            };
        }
    }, [state.isAvailable, state.isAudioManagerReady, updateState]);
    // Setup native event listeners - optimized dependencies
    (0, react_1.useEffect)(() => {
        if (!serviceRef.current)
            return;
        eventManagerRef.current.setupNativeListeners(options, stateManager, alertProvider, errorTracker, updateState, updateAudioLevel);
        return () => {
            eventManagerRef.current.cleanup();
        };
    }, [
        options.onChunkReady,
        options.onError,
        options.onStateChange,
        options.onInterruption,
        options.chunkUploader,
        options.interruptionHandler,
        updateState,
        updateAudioLevel,
    ]); // Add updateState and updateAudioLevel to dependencies
    // iOS emits `onMaxDurationReached` from native when its own maxDurationTimer
    // fires, then immediately emits `onStateChange(isRecording: false)`. The JS
    // duration-tracking interval below races and is typically cleared by the
    // state change before it can fire — so without this subscription, iOS
    // consumers never see the max-duration callback. Android has no native
    // timer, so this is a no-op there and the JS interval handles it instead.
    (0, react_1.useEffect)(() => {
        const sub = NativeAudioChunkRecorder_1.AudioChunkRecorderEventEmitter.addListener("onMaxDurationReached", (data) => {
            var _a;
            if (maxDurationFiredRef.current)
                return;
            maxDurationFiredRef.current = true;
            if (durationIntervalRef.current) {
                clearInterval(durationIntervalRef.current);
                durationIntervalRef.current = null;
            }
            recordingStartTimeRef.current = null;
            const maxDurationData = {
                duration: data.duration,
                maxDuration: data.maxDuration,
                chunks: chunksRef.current,
            };
            eventManagerRef.current.notifyListeners("onMaxDurationReached", maxDurationData);
            (_a = onMaxDurationReachedRef.current) === null || _a === void 0 ? void 0 : _a.call(onMaxDurationReachedRef, maxDurationData);
        });
        return () => {
            sub.remove();
        };
    }, []);
    // Memoized actions to prevent unnecessary re-creation
    const startRecording = (0, react_1.useCallback)(async (recordingOptions) => {
        var _a;
        // Check if already recording to avoid "Recording is already in progress" error
        if (state.isRecording) {
            return;
        }
        try {
            const finalOptions = {
                ...options.defaultRecordingOptions,
                ...recordingOptions,
            };
            // Set max duration (default 2 hours)
            const maxDuration = (_a = finalOptions.maxRecordingDuration) !== null && _a !== void 0 ? _a : 7200;
            errorTracker.addBreadcrumb({
                message: "Starting audio recording",
                category: "audio_recording",
                level: "info",
                data: { ...finalOptions, maxDuration },
            });
            const result = await audioManager_1.audioManager.startRecording(finalOptions);
            console.log("AudioRecorderCore: ✅ Recording started:", result);
            // Start duration tracking
            recordingStartTimeRef.current = Date.now();
            pausedTimeRef.current = 0;
            maxDurationFiredRef.current = false;
            updateState({ maxRecordingDuration: maxDuration });
        }
        catch (error) {
            console.error("AudioRecorderCore: ❌ Start recording failed:", error);
            errorTracker.captureException(error, {
                action: "start_recording",
                options: recordingOptions,
            });
            throw error;
        }
    }, [
        state.isRecording,
        options.defaultRecordingOptions,
        errorTracker,
        updateState,
    ]);
    const stopRecording = (0, react_1.useCallback)(async () => {
        try {
            errorTracker.addBreadcrumb({
                message: "Stopping audio recording",
                category: "audio_recording",
                level: "info",
            });
            const result = await audioManager_1.audioManager.stopRecording();
            console.log("AudioRecorderCore: ✅ Recording stopped:", result);
        }
        catch (error) {
            console.error("AudioRecorderCore: Stop recording failed:", error);
            errorTracker.captureException(error, {
                action: "stop_recording",
            });
            throw error;
        }
    }, [errorTracker]);
    const pauseRecording = (0, react_1.useCallback)(async () => {
        if (!serviceRef.current) {
            throw new Error("AudioRecorderCore: Service not available");
        }
        try {
            await serviceRef.current.pauseRecording();
            // Pause duration tracking
            if (recordingStartTimeRef.current) {
                pausedTimeRef.current += Date.now() - recordingStartTimeRef.current;
            }
        }
        catch (error) {
            console.error("AudioRecorderCore: Pause recording failed:", error);
            throw error;
        }
    }, []);
    const resumeRecording = (0, react_1.useCallback)(async () => {
        if (!serviceRef.current) {
            throw new Error("AudioRecorderCore: Service not available");
        }
        try {
            await serviceRef.current.resumeRecording();
            // Resume duration tracking
            if (recordingStartTimeRef.current) {
                recordingStartTimeRef.current = Date.now();
            }
        }
        catch (error) {
            console.error("AudioRecorderCore: Resume recording failed:", error);
            throw error;
        }
    }, []);
    const clearChunks = (0, react_1.useCallback)(() => {
        var _a;
        updateState({ chunks: [] });
        // Note: clearAllChunkFiles is async, but we don't await here for backwards compatibility
        (_a = serviceRef.current) === null || _a === void 0 ? void 0 : _a.clearAllChunkFiles().catch((error) => {
            console.error("AudioRecorderCore: Failed to clear chunk files:", error);
        });
    }, [updateState]);
    const clearAllChunkFiles = (0, react_1.useCallback)(async () => {
        if (!serviceRef.current) {
            throw new Error("AudioRecorderCore: Service not available");
        }
        try {
            await serviceRef.current.clearAllChunkFiles();
            updateState({ chunks: [] });
        }
        catch (error) {
            console.error("AudioRecorderCore: Clear files failed:", error);
            throw error;
        }
    }, [updateState]);
    const checkPermissions = (0, react_1.useCallback)(async () => {
        if (!serviceRef.current) {
            throw new Error("AudioRecorderCore: Service not available");
        }
        try {
            const granted = await serviceRef.current.checkPermissions();
            updateState({ hasPermission: granted });
            errorTracker.addBreadcrumb({
                message: `Permissions check result: ${granted}`,
                category: "permissions",
                level: granted ? "info" : "warning",
            });
            console.log("AudioRecorderCore: ✅ Permissions check:", granted);
        }
        catch (error) {
            console.error("AudioRecorderCore: Check permissions failed:", error);
            errorTracker.captureException(error, {
                action: "check_permissions",
            });
            updateState({ hasPermission: false });
            throw error;
        }
    }, [updateState, errorTracker]);
    // Auto check permissions on mount - moved after checkPermissions definition
    (0, react_1.useEffect)(() => {
        if (options.autoCheckPermissions !== false && serviceRef.current) {
            (async () => {
                await checkPermissions();
            })();
        }
    }, [options.autoCheckPermissions, checkPermissions]);
    // Optimized duration tracking using refs to avoid unnecessary re-renders
    (0, react_1.useEffect)(() => {
        if (isRecordingRef.current && !isPausedRef.current) {
            if (durationIntervalRef.current) {
                clearInterval(durationIntervalRef.current);
            }
            durationIntervalRef.current = setInterval(() => {
                if (recordingStartTimeRef.current &&
                    !isPausedRef.current &&
                    !maxDurationFiredRef.current) {
                    const elapsed = (Date.now() -
                        recordingStartTimeRef.current -
                        pausedTimeRef.current) /
                        1000;
                    updateState({ recordingDuration: elapsed });
                    // Check if max duration reached
                    if (elapsed >= state.maxRecordingDuration) {
                        // Latch first so any racing tick (or a re-created interval from
                        // a re-running effect reading a stale start time) bails out.
                        maxDurationFiredRef.current = true;
                        recordingStartTimeRef.current = null;
                        clearInterval(durationIntervalRef.current);
                        durationIntervalRef.current = null;
                        // Stop recording and notify
                        stopRecording()
                            .then(() => {
                            var _a;
                            const maxDurationData = {
                                duration: elapsed,
                                maxDuration: state.maxRecordingDuration,
                                chunks: chunksRef.current,
                            };
                            eventManagerRef.current.notifyListeners("onMaxDurationReached", maxDurationData);
                            (_a = onMaxDurationReachedRef.current) === null || _a === void 0 ? void 0 : _a.call(onMaxDurationReachedRef, maxDurationData);
                            errorTracker.addBreadcrumb({
                                message: `Max recording duration reached: ${elapsed}s / ${state.maxRecordingDuration}s`,
                                category: "recording_limit",
                                level: "info",
                                data: maxDurationData,
                            });
                        })
                            .catch((error) => {
                            console.error("AudioRecorderCore: Failed to stop recording on max duration:", error);
                        });
                    }
                }
            }, 1000);
        }
        else if (!isRecordingRef.current && durationIntervalRef.current) {
            // Stop tracking when recording stops
            clearInterval(durationIntervalRef.current);
            durationIntervalRef.current = null;
            recordingStartTimeRef.current = null;
            pausedTimeRef.current = 0;
            updateState({ recordingDuration: 0 });
        }
        return () => {
            if (durationIntervalRef.current) {
                clearInterval(durationIntervalRef.current);
                durationIntervalRef.current = null;
            }
        };
    }, [
        state.isRecording,
        state.isPaused,
        state.maxRecordingDuration,
        updateState,
        stopRecording,
        errorTracker,
    ]);
    // Auto start recording when conditions are met
    (0, react_1.useEffect)(() => {
        if (options.autoStartRecording &&
            state.isAvailable &&
            state.isAudioManagerReady &&
            state.hasPermission &&
            !state.isRecording &&
            !state.isPaused &&
            !autoStartAttemptedRef.current &&
            serviceRef.current) {
            autoStartAttemptedRef.current = true;
            startRecording().catch((error) => {
                console.error("AudioRecorderCore: Auto-start failed:", error);
                // Reset flag on error so it can try again
                autoStartAttemptedRef.current = false;
            });
        }
    }, [
        options.autoStartRecording,
        state.isAvailable,
        state.isAudioManagerReady,
        state.hasPermission,
        state.isRecording,
        state.isPaused,
        startRecording,
    ]);
    // Listen to AudioManager state changes
    (0, react_1.useEffect)(() => {
        const unsubscribe = audioManager_1.audioManager.addListener((type, active) => {
            if (type === "recording") {
                if (!active && state.isRecording) {
                    // Recording was stopped by another hook or the manager
                    updateState({
                        isRecording: false,
                        isPaused: false,
                    });
                }
            }
        });
        return unsubscribe;
    }, [state.isRecording, updateState]);
    // Optimized event subscription methods with memoization
    const onChunkReady = (0, react_1.useCallback)((callback) => {
        eventManagerRef.current.addListener("onChunkReady", callback);
        return () => {
            eventManagerRef.current.removeListener("onChunkReady", callback);
        };
    }, []);
    const onAudioLevel = (0, react_1.useCallback)((callback) => {
        eventManagerRef.current.addListener("onAudioLevel", callback);
        return () => {
            eventManagerRef.current.removeListener("onAudioLevel", callback);
        };
    }, []);
    const onError = (0, react_1.useCallback)((callback) => {
        eventManagerRef.current.addListener("onError", callback);
        return () => {
            eventManagerRef.current.removeListener("onError", callback);
        };
    }, []);
    const onInterruption = (0, react_1.useCallback)((callback) => {
        eventManagerRef.current.addListener("onInterruption", callback);
        return () => {
            eventManagerRef.current.removeListener("onInterruption", callback);
        };
    }, []);
    const onStateChange = (0, react_1.useCallback)((callback) => {
        eventManagerRef.current.addListener("onStateChange", callback);
        return () => {
            eventManagerRef.current.removeListener("onStateChange", callback);
        };
    }, []);
    const onMaxDurationReached = (0, react_1.useCallback)((callback) => {
        eventManagerRef.current.addListener("onMaxDurationReached", callback);
        return () => {
            eventManagerRef.current.removeListener("onMaxDurationReached", callback);
        };
    }, []);
    // Utility functions with memoization
    const getExpectedChunkDuration = (0, react_1.useCallback)(() => {
        var _a;
        return ((_a = options.defaultRecordingOptions) === null || _a === void 0 ? void 0 : _a.chunkSeconds) || 30;
    }, [(_a = options.defaultRecordingOptions) === null || _a === void 0 ? void 0 : _a.chunkSeconds]); // Only depend on specific prop
    // Calculate remaining duration with memoization
    const remainingDuration = (0, react_1.useMemo)(() => {
        return Math.max(0, state.maxRecordingDuration - state.recordingDuration);
    }, [state.maxRecordingDuration, state.recordingDuration]);
    // Memoized return object to prevent unnecessary re-renders
    const returnValue = (0, react_1.useMemo)(() => ({
        // Service
        service: serviceRef.current,
        // State
        isRecording: state.isRecording,
        isPaused: state.isPaused,
        hasPermission: state.hasPermission,
        chunks: state.chunks,
        audioLevel: audioLevel, // Use separated state
        hasAudio: hasAudio, // Use separated state
        isAvailable: state.isAvailable,
        isInterrupted: state.isInterrupted,
        // Recording duration tracking
        recordingDuration: state.recordingDuration,
        maxRecordingDuration: state.maxRecordingDuration,
        remainingDuration: remainingDuration,
        // Actions
        startRecording,
        stopRecording,
        pauseRecording,
        resumeRecording,
        clearChunks,
        clearAllChunkFiles,
        checkPermissions,
        // Duration utilities
        getExpectedChunkDuration,
        // Event handlers
        onChunkReady,
        onAudioLevel,
        onError,
        onInterruption,
        onStateChange,
        onMaxDurationReached,
    }), [
        state.isRecording,
        state.isPaused,
        state.hasPermission,
        state.chunks,
        audioLevel, // Use separated state
        hasAudio, // Use separated state
        state.isAvailable,
        state.isInterrupted,
        state.recordingDuration,
        state.maxRecordingDuration,
        remainingDuration,
        startRecording,
        stopRecording,
        pauseRecording,
        resumeRecording,
        clearChunks,
        clearAllChunkFiles,
        checkPermissions,
        getExpectedChunkDuration,
        onChunkReady,
        onAudioLevel,
        onError,
        onInterruption,
        onStateChange,
        onMaxDurationReached,
    ]);
    return returnValue;
};
exports.useAudioRecorderCore = useAudioRecorderCore;
