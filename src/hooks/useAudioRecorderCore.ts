/**
 * Core audio recorder hook - modular and framework-agnostic
 * This is the main hook that would be part of the NPM module
 */

import { useRef, useEffect, useCallback, useState, useMemo } from "react";

import {
  NativeAudioChunkRecorder,
  AudioChunkRecorderEventEmitter,
} from "../NativeAudioChunkRecorder";
import type {
  AudioRecorderCoreOptions,
  AudioRecorderCoreReturn,
  ChunkData,
  ErrorData,
  InterruptionData,
  StateChangeData,
  AudioLevelData,
  RecordingOptions,
  MaxDurationReachedData,
  FullRecordingData,
} from "../types";
import { reactNativeAlertProvider } from "../providers/reactNativeAlertProvider";
import { createSimpleStateManager } from "../providers/simpleStateManager";
import { audioManager } from "../providers/audioManager";
import { noopErrorTracker } from "../providers/errorTracker";

// Mock native module interface - in real implementation this would come from native
// Native interface - using the actual bridge
interface AudioRecorderNative {
  startRecording: (options: RecordingOptions) => Promise<string>;
  stopRecording: () => Promise<string>;
  pauseRecording: () => Promise<string>;
  resumeRecording: () => Promise<string>;
  clearAllChunkFiles: () => Promise<string>;
  checkPermissions: () => Promise<boolean>;
  isAvailable: () => Promise<boolean>;
}

// Performance constants
const AUDIO_LEVEL_THROTTLE_MS = 100; // Throttle audio level updates
const STATE_UPDATE_DEBOUNCE_MS = 50; // Debounce state updates

// Optimized event listener manager
class EventListenerManager {
  private listeners = {
    onChunkReady: new Set<(chunk: ChunkData) => void>(),
    onAudioLevel: new Set<(levelData: AudioLevelData) => void>(),
    onError: new Set<(error: ErrorData) => void>(),
    onInterruption: new Set<(interruption: InterruptionData) => void>(),
    onStateChange: new Set<(state: StateChangeData) => void>(),
    onMaxDurationReached: new Set<(data: MaxDurationReachedData) => void>(),
    onFullRecordingReady: new Set<(data: FullRecordingData) => void>(),
  };

  private nativeListeners: any[] = [];
  private lastAudioLevelUpdate = 0;
  private stateUpdateTimeout: NodeJS.Timeout | null = null;

  addListener<T extends keyof typeof this.listeners>(
    event: T,
    callback: Parameters<(typeof this.listeners)[T]["add"]>[0]
  ) {
    this.listeners[event].add(callback as any);
  }

  removeListener<T extends keyof typeof this.listeners>(
    event: T,
    callback: Parameters<(typeof this.listeners)[T]["add"]>[0]
  ) {
    this.listeners[event].delete(callback as any);
  }

  notifyListeners<T extends keyof typeof this.listeners>(
    event: T,
    data: Parameters<Parameters<(typeof this.listeners)[T]["add"]>[0]>[0]
  ) {
    // Throttle audio level updates for performance
    if (event === "onAudioLevel") {
      const now = Date.now();
      if (now - this.lastAudioLevelUpdate < AUDIO_LEVEL_THROTTLE_MS) {
        return;
      }
      this.lastAudioLevelUpdate = now;
    }

    this.listeners[event].forEach((listener: any) => {
      try {
        listener(data);
      } catch (error) {
        console.error(`AudioRecorderCore: Error in ${event} listener:`, error);
      }
    });
  }

  setupNativeListeners(
    options: AudioRecorderCoreOptions,
    stateManager: any,
    alertProvider: any,
    errorTracker: any,
    updateState: (updates: any) => void,
    updateAudioLevel: (level: number, hasAudio: boolean) => void
  ) {
    // Clear existing listeners
    this.cleanup();

    // Chunk ready listener with low priority to avoid interfering with audio level
    const chunkListener = AudioChunkRecorderEventEmitter.addListener(
      "onChunkReady",
      (chunk: ChunkData) => {
        const dispatch = () => {
          this.notifyListeners("onChunkReady", chunk);
          options.onChunkReady?.(chunk);

          // Upload chunk if uploader is provided
          if (options.chunkUploader) {
            options.chunkUploader.upload(chunk).catch((error) => {
              console.error("AudioRecorderCore: Chunk upload failed:", error);
              errorTracker.captureException(error, {
                chunk: chunk,
                action: "chunk_upload",
                chunkSeq: chunk.sequence,
              });
              options.chunkUploader?.onError?.(
                chunk.sequence.toString(),
                error.message || "Upload failed"
              );
            });
          }
        };

        // Non-final chunks are deferred to next tick to keep audio-level
        // updates smooth during ongoing capture. The FINAL chunk must dispatch
        // synchronously: native emits onChunkReady(isLast:YES) immediately
        // followed by onMaxDurationReached, whose handler runs synchronously
        // (no setTimeout) and tears down consumer state (e.g. clears the
        // requestId the chunk uploader needs). If we defer the final chunk
        // too, that teardown wins the race and the final chunk is dropped —
        // server never receives isFinal=true and the recording never
        // finalizes. Recording has ended at this point, so the audio-level
        // priority concern no longer applies.
        if (chunk.isLastChunk === true) {
          dispatch();
        } else {
          setTimeout(dispatch, 0);
        }
      }
    );

    // Audio level listener with optimized high-priority handling
    const levelListener = AudioChunkRecorderEventEmitter.addListener(
      "onAudioLevel",
      (data: AudioLevelData) => {
        // Update audio level using optimized function to prevent main state rerenders
        // This now has higher priority to maintain smooth animations
        updateAudioLevel(data.level, data.hasAudio);
        this.notifyListeners("onAudioLevel", data);
      }
    );

    // Error listener
    const errorListener = AudioChunkRecorderEventEmitter.addListener(
      "onError",
      (error: ErrorData) => {
        console.error("AudioRecorderCore: Native error:", error);
        errorTracker.captureException(new Error(error.message), {
          errorCode: error.code,
          source: "native_module",
        });
        this.notifyListeners("onError", error);
        options.onError?.(error);
      }
    );

    // State change listener with debouncing
    const stateListener = AudioChunkRecorderEventEmitter.addListener(
      "onStateChange",
      (state: StateChangeData) => {
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
          this.notifyListeners("onStateChange", state);
          options.onStateChange?.(state);
        }, STATE_UPDATE_DEBOUNCE_MS);
      }
    );

    // Interruption listener
    const interruptionListener = AudioChunkRecorderEventEmitter.addListener(
      "onInterruption",
      (interruption: InterruptionData) => {
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
        } else if (interruption.type === "ended") {
          updateState({ isInterrupted: false });
          stateManager.setState("audioInterruption", false);
        }

        // Handle interruption with custom handler or default behavior
        if (options.interruptionHandler) {
          if (interruption.type === "audioDeviceDisconnected") {
            options.interruptionHandler.onDeviceDisconnected(interruption);
          } else {
            options.interruptionHandler.onInterruption(interruption);
          }
        } else {
          // Default interruption handling
          this.handleInterruptionDefault(interruption, alertProvider);
        }

        options.onInterruption?.(interruption);
      }
    );

    // Full recording listener — fires once on stop with the single
    // continuous WAV captured for the whole session.
    const fullRecordingListener = AudioChunkRecorderEventEmitter.addListener(
      "onFullRecordingReady",
      (data: FullRecordingData) => {
        this.notifyListeners("onFullRecordingReady", data);
        options.onFullRecordingReady?.(data);
      }
    );

    this.nativeListeners = [
      chunkListener,
      levelListener,
      errorListener,
      stateListener,
      interruptionListener,
      fullRecordingListener,
    ];
  }

  private handleInterruptionDefault(
    interruption: InterruptionData,
    alertProvider: any
  ) {
    if (interruption.type === "began") {
      alertProvider.showAlert(
        "Call in Progress",
        "Recording paused due to incoming call. Recording will resume when the call ends.",
        [{ text: "OK" }]
      );
    } else if (interruption.type === "audioDeviceDisconnected") {
      alertProvider.showAlert(
        "Audio Device Disconnected",
        "Your audio device was disconnected. Please reconnect and try again.",
        [{ text: "OK" }]
      );
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

export const useAudioRecorderCore = (
  options: AudioRecorderCoreOptions = {}
): AudioRecorderCoreReturn => {
  // Use provided dependencies or defaults - memoized to prevent re-creation
  const alertProvider = useMemo(
    () => options.alertProvider || reactNativeAlertProvider,
    [options.alertProvider]
  );
  const stateManager = useMemo(
    () => options.stateManager || createSimpleStateManager(),
    [options.stateManager]
  );
  const errorTracker = useMemo(
    () => options.errorTracker || noopErrorTracker,
    [options.errorTracker]
  );

  // Optimized state management - separate frequently changing values
  const [state, setState] = useState({
    isRecording: false,
    isPaused: false,
    hasPermission: false,
    chunks: [] as ChunkData[],
    isAvailable: false,
    isInterrupted: false,
    recordingDuration: 0,
    maxRecordingDuration: 7200, // 2 hours default
    isAudioManagerReady: false, // Track AudioManager initialization
  });

  // Separate state for frequently changing values to prevent rerenders
  const [audioLevel, setAudioLevel] = useState(0);
  const [hasAudio, setHasAudio] = useState(false);

  // Recording duration tracking
  const recordingStartTimeRef = useRef<number | null>(null);
  const pausedTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Latched once we fire onMaxDurationReached for a session, cleared on the
  // next startRecording. Prevents the duration-tracking effect from
  // re-triggering when consumers pass a fresh `options.onMaxDurationReached`
  // callback every render (which causes the effect to re-run, re-create the
  // interval, and read a stale recordingStartTimeRef).
  const maxDurationFiredRef = useRef(false);
  // Stash the consumer's onMaxDurationReached so the duration-tracking
  // effect doesn't need it in its dep array. Listing it there caused the
  // effect to thrash whenever the consumer re-rendered with a fresh callback.
  const onMaxDurationReachedRef = useRef(options.onMaxDurationReached);
  onMaxDurationReachedRef.current = options.onMaxDurationReached;

  // Event listener manager - singleton instance
  const eventManagerRef = useRef<EventListenerManager | null>(null);
  if (!eventManagerRef.current) {
    eventManagerRef.current = new EventListenerManager();
  }

  // Service ref
  const serviceRef = useRef<AudioRecorderNative | null>(null);

  // Auto start tracking
  const autoStartAttemptedRef = useRef(false);

  // Refs for frequently accessed values to prevent unnecessary effect re-runs
  const chunksRef = useRef<ChunkData[]>([]);
  const isRecordingRef = useRef(false);
  const isPausedRef = useRef(false);

  // Update refs when state changes
  useEffect(() => {
    chunksRef.current = state.chunks;
    isRecordingRef.current = state.isRecording;
    isPausedRef.current = state.isPaused;
  }, [state.chunks, state.isRecording, state.isPaused]);

  // Memoized state setters to prevent unnecessary re-renders
  const updateState = useCallback((updates: Partial<typeof state>) => {
    setState((prev) => ({ ...prev, ...updates }));
  }, []);

  // Optimized audio level update - doesn't trigger main state updates
  const updateAudioLevel = useCallback((level: number, hasAudio: boolean) => {
    setAudioLevel(level);
    setHasAudio(hasAudio);
  }, []);

  // Initialize service - only once
  useEffect(() => {
    console.log("AudioRecorderCore: 🔄 Initializing native service...");
    try {
      serviceRef.current = NativeAudioChunkRecorder;
      NativeAudioChunkRecorder.isAvailable()
        .then((available) => {
          console.log(
            "AudioRecorderCore: ✅ Native service available:",
            available
          );
          updateState({ isAvailable: available });
        })
        .catch((error) => {
          console.error(
            "AudioRecorderCore: Failed to check availability:",
            error
          );
          updateState({ isAvailable: false });
        });
    } catch (error) {
      console.error("AudioRecorderCore: Failed to initialize service:", error);
      updateState({ isAvailable: false });
    }
  }, [updateState]); // Add updateState to dependencies

  // Wait for AudioManager to be ready after service is available
  useEffect(() => {
    if (state.isAvailable && !state.isAudioManagerReady) {
      console.log(
        "AudioRecorderCore: 🔄 Waiting for AudioManager to be ready..."
      );

      // Give AudioManager time to initialize
      const initTimeout = setTimeout(async () => {
        try {
          // Test the AudioManager with a simple operation
          const managerState = audioManager.getState();
          console.log("AudioRecorderCore: AudioManager state:", managerState);

          // Additional check - try to access the native service through AudioManager
          // This ensures the initialization promise has resolved
          await new Promise((resolve) => setTimeout(resolve, 100));

          updateState({ isAudioManagerReady: true });
          console.log(
            "AudioRecorderCore: ✅ AudioManager is ready for auto-start"
          );
        } catch (error) {
          console.error("AudioRecorderCore: AudioManager not ready:", error);
          // Retry after a longer delay
          setTimeout(() => {
            if (!state.isAudioManagerReady) {
              console.log(
                "AudioRecorderCore: 🔄 Retrying AudioManager initialization..."
              );
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
  useEffect(() => {
    if (!serviceRef.current) return;

    eventManagerRef.current!.setupNativeListeners(
      options,
      stateManager,
      alertProvider,
      errorTracker,
      updateState,
      updateAudioLevel
    );

    return () => {
      eventManagerRef.current!.cleanup();
    };
  }, [
    options.onChunkReady,
    options.onError,
    options.onStateChange,
    options.onInterruption,
    options.onFullRecordingReady,
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
  useEffect(() => {
    const sub = AudioChunkRecorderEventEmitter.addListener(
      "onMaxDurationReached",
      (data: { duration: number; maxDuration: number }) => {
        if (maxDurationFiredRef.current) return;
        maxDurationFiredRef.current = true;

        if (durationIntervalRef.current) {
          clearInterval(durationIntervalRef.current);
          durationIntervalRef.current = null;
        }
        recordingStartTimeRef.current = null;

        const maxDurationData: MaxDurationReachedData = {
          duration: data.duration,
          maxDuration: data.maxDuration,
          chunks: chunksRef.current,
        };

        eventManagerRef.current!.notifyListeners(
          "onMaxDurationReached",
          maxDurationData
        );
        onMaxDurationReachedRef.current?.(maxDurationData);
      }
    );

    return () => {
      sub.remove();
    };
  }, []);

  // Memoized actions to prevent unnecessary re-creation
  const startRecording = useCallback(
    async (recordingOptions?: RecordingOptions) => {
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
        const maxDuration = finalOptions.maxRecordingDuration ?? 7200;

        errorTracker.addBreadcrumb({
          message: "Starting audio recording",
          category: "audio_recording",
          level: "info",
          data: { ...finalOptions, maxDuration },
        });

        const result = await audioManager.startRecording(finalOptions);
        console.log("AudioRecorderCore: ✅ Recording started:", result);

        // Start duration tracking
        recordingStartTimeRef.current = Date.now();
        pausedTimeRef.current = 0;
        maxDurationFiredRef.current = false;
        updateState({ maxRecordingDuration: maxDuration });
      } catch (error) {
        console.error("AudioRecorderCore: ❌ Start recording failed:", error);
        errorTracker.captureException(error as Error, {
          action: "start_recording",
          options: recordingOptions,
        });
        throw error;
      }
    },
    [
      state.isRecording,
      options.defaultRecordingOptions,
      errorTracker,
      updateState,
    ]
  );

  const stopRecording = useCallback(async () => {
    try {
      errorTracker.addBreadcrumb({
        message: "Stopping audio recording",
        category: "audio_recording",
        level: "info",
      });

      const result = await audioManager.stopRecording();
      console.log("AudioRecorderCore: ✅ Recording stopped:", result);
    } catch (error) {
      console.error("AudioRecorderCore: Stop recording failed:", error);
      errorTracker.captureException(error as Error, {
        action: "stop_recording",
      });
      throw error;
    }
  }, [errorTracker]);

  const pauseRecording = useCallback(async () => {
    if (!serviceRef.current) {
      throw new Error("AudioRecorderCore: Service not available");
    }

    try {
      await serviceRef.current.pauseRecording();
      // Pause duration tracking
      if (recordingStartTimeRef.current) {
        pausedTimeRef.current += Date.now() - recordingStartTimeRef.current;
      }
    } catch (error) {
      console.error("AudioRecorderCore: Pause recording failed:", error);
      throw error;
    }
  }, []);

  const resumeRecording = useCallback(async () => {
    if (!serviceRef.current) {
      throw new Error("AudioRecorderCore: Service not available");
    }

    try {
      await serviceRef.current.resumeRecording();
      // Resume duration tracking
      if (recordingStartTimeRef.current) {
        recordingStartTimeRef.current = Date.now();
      }
    } catch (error) {
      console.error("AudioRecorderCore: Resume recording failed:", error);
      throw error;
    }
  }, []);

  const clearChunks = useCallback(() => {
    updateState({ chunks: [] });
    // Note: clearAllChunkFiles is async, but we don't await here for backwards compatibility
    serviceRef.current?.clearAllChunkFiles().catch((error: unknown) => {
      console.error("AudioRecorderCore: Failed to clear chunk files:", error);
    });
  }, [updateState]);

  const clearAllChunkFiles = useCallback(async () => {
    if (!serviceRef.current) {
      throw new Error("AudioRecorderCore: Service not available");
    }

    try {
      await serviceRef.current.clearAllChunkFiles();
      updateState({ chunks: [] });
    } catch (error) {
      console.error("AudioRecorderCore: Clear files failed:", error);
      throw error;
    }
  }, [updateState]);

  const checkPermissions = useCallback(async () => {
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
    } catch (error) {
      console.error("AudioRecorderCore: Check permissions failed:", error);
      errorTracker.captureException(error as Error, {
        action: "check_permissions",
      });
      updateState({ hasPermission: false });
      throw error;
    }
  }, [updateState, errorTracker]);

  // Auto check permissions on mount - moved after checkPermissions definition
  useEffect(() => {
    if (options.autoCheckPermissions !== false && serviceRef.current) {
      (async () => {
        await checkPermissions();
      })();
    }
  }, [options.autoCheckPermissions, checkPermissions]);

  // Optimized duration tracking using refs to avoid unnecessary re-renders
  useEffect(() => {
    if (isRecordingRef.current && !isPausedRef.current) {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }

      durationIntervalRef.current = setInterval(() => {
        if (
          recordingStartTimeRef.current &&
          !isPausedRef.current &&
          !maxDurationFiredRef.current
        ) {
          const elapsed =
            (Date.now() -
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
            clearInterval(durationIntervalRef.current!);
            durationIntervalRef.current = null;

            // Stop recording and notify
            stopRecording()
              .then(() => {
                const maxDurationData: MaxDurationReachedData = {
                  duration: elapsed,
                  maxDuration: state.maxRecordingDuration,
                  chunks: chunksRef.current,
                };

                eventManagerRef.current!.notifyListeners(
                  "onMaxDurationReached",
                  maxDurationData
                );
                onMaxDurationReachedRef.current?.(maxDurationData);

                errorTracker.addBreadcrumb({
                  message: `Max recording duration reached: ${elapsed}s / ${state.maxRecordingDuration}s`,
                  category: "recording_limit",
                  level: "info",
                  data: maxDurationData,
                });
              })
              .catch((error) => {
                console.error(
                  "AudioRecorderCore: Failed to stop recording on max duration:",
                  error
                );
              });
          }
        }
      }, 1000);
    } else if (!isRecordingRef.current && durationIntervalRef.current) {
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
  useEffect(() => {
    if (
      options.autoStartRecording &&
      state.isAvailable &&
      state.isAudioManagerReady &&
      state.hasPermission &&
      !state.isRecording &&
      !state.isPaused &&
      !autoStartAttemptedRef.current &&
      serviceRef.current
    ) {
      autoStartAttemptedRef.current = true;
      startRecording().catch((error: unknown) => {
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
  useEffect(() => {
    const unsubscribe = audioManager.addListener((type, active) => {
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
  const onChunkReady = useCallback((callback: (chunk: ChunkData) => void) => {
    eventManagerRef.current!.addListener("onChunkReady", callback);
    return () => {
      eventManagerRef.current!.removeListener("onChunkReady", callback);
    };
  }, []);

  const onAudioLevel = useCallback(
    (callback: (levelData: AudioLevelData) => void) => {
      eventManagerRef.current!.addListener("onAudioLevel", callback);
      return () => {
        eventManagerRef.current!.removeListener("onAudioLevel", callback);
      };
    },
    []
  );

  const onError = useCallback((callback: (error: ErrorData) => void) => {
    eventManagerRef.current!.addListener("onError", callback);
    return () => {
      eventManagerRef.current!.removeListener("onError", callback);
    };
  }, []);

  const onInterruption = useCallback(
    (callback: (interruption: InterruptionData) => void) => {
      eventManagerRef.current!.addListener("onInterruption", callback);
      return () => {
        eventManagerRef.current!.removeListener("onInterruption", callback);
      };
    },
    []
  );

  const onStateChange = useCallback(
    (callback: (state: StateChangeData) => void) => {
      eventManagerRef.current!.addListener("onStateChange", callback);
      return () => {
        eventManagerRef.current!.removeListener("onStateChange", callback);
      };
    },
    []
  );

  const onMaxDurationReached = useCallback(
    (callback: (data: MaxDurationReachedData) => void) => {
      eventManagerRef.current!.addListener("onMaxDurationReached", callback);
      return () => {
        eventManagerRef.current!.removeListener(
          "onMaxDurationReached",
          callback
        );
      };
    },
    []
  );

  const onFullRecordingReady = useCallback(
    (callback: (data: FullRecordingData) => void) => {
      eventManagerRef.current!.addListener("onFullRecordingReady", callback);
      return () => {
        eventManagerRef.current!.removeListener(
          "onFullRecordingReady",
          callback
        );
      };
    },
    []
  );

  // Utility functions with memoization
  const getExpectedChunkDuration = useCallback((): number => {
    return options.defaultRecordingOptions?.chunkSeconds || 30;
  }, [options.defaultRecordingOptions?.chunkSeconds]); // Only depend on specific prop

  // Calculate remaining duration with memoization
  const remainingDuration = useMemo(() => {
    return Math.max(0, state.maxRecordingDuration - state.recordingDuration);
  }, [state.maxRecordingDuration, state.recordingDuration]);

  // Memoized return object to prevent unnecessary re-renders
  const returnValue = useMemo<AudioRecorderCoreReturn>(
    () => ({
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
      onFullRecordingReady,
    }),
    [
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
      onFullRecordingReady,
    ]
  );

  return returnValue;
};
