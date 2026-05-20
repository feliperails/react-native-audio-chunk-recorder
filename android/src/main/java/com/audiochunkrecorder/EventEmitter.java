package com.audiochunkrecorder;

import android.util.Log;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * EventEmitter - Handles all React Native event emissions
 * 
 * Centralized event emission to JavaScript with proper error handling
 * and context validation.
 */
public class EventEmitter {
    private static final String TAG = "EventEmitter";
    private final ReactApplicationContext reactContext;

    public EventEmitter(ReactApplicationContext reactContext) {
        this.reactContext = reactContext;
    }

    /**
     * Send a generic event to JavaScript
     */
    public void sendEvent(String name, WritableMap params) {
        if (reactContext != null && reactContext.hasActiveCatalystInstance()) {
            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                       .emit(name, params);
        } else {
            Log.w(TAG, "React context not ready → event " + name + " lost");
        }
    }

    /**
     * Send state change event
     */
    public void sendStateChangeEvent(boolean isRecording, boolean isPaused) {
        WritableMap map = Arguments.createMap();
        map.putBoolean("isRecording", isRecording);
        map.putBoolean("isPaused", isPaused);
        sendEvent("onStateChange", map);
    }

    /**
     * Send error event
     */
    public void sendErrorEvent(String message) {
        WritableMap map = Arguments.createMap();
        map.putString("message", message);
        sendEvent("onError", map);
    }

    /**
     * Send audio level event
     */
    public void sendAudioLevelEvent(double level) {
        WritableMap map = Arguments.createMap();
        map.putDouble("level", level);
        map.putBoolean("hasAudio", level > 0.01);
        sendEvent("onAudioLevel", map);
    }

    /**
     * Send chunk ready event with timing info
     */
    public void sendChunkReadyEvent(String path, int sequence, long timestamp, long fileSize) {
        sendChunkReadyEvent(path, sequence, timestamp, fileSize, false);
    }

    /**
     * Send chunk ready event with timing info and last chunk flag
     */
    public void sendChunkReadyEvent(String path, int sequence, long timestamp, long fileSize, boolean isLastChunk) {
        WritableMap map = Arguments.createMap();
        map.putString("path", path);
        map.putInt("sequence", sequence);
        map.putDouble("timestamp", timestamp);
        map.putDouble("size", fileSize);
        map.putBoolean("isLastChunk", isLastChunk);
        sendEvent("onChunkReady", map);
    }

    /**
     * Send chunk event with complete chunk information
     */
    public void sendChunkEvent(int chunkIndex, String path, long timestamp, long size) {
        WritableMap map = Arguments.createMap();
        map.putInt("sequence", chunkIndex); // Use "sequence" to match ChunkData interface
        map.putString("path", path);
        map.putDouble("timestamp", timestamp);
        map.putDouble("size", size);
        sendEvent("onChunkReady", map);
        
        Log.d(TAG, "📤 CHUNK EVENT SENT: sequence=" + chunkIndex + ", path=" + path + ", size=" + size);
    }

    /**
     * Send full-recording-ready event with the single continuous WAV path.
     */
    public void sendFullRecordingReadyEvent(String path, long startTimestamp, long fileSize, double durationSeconds) {
        WritableMap map = Arguments.createMap();
        map.putString("path", path);
        map.putDouble("timestamp", startTimestamp);
        map.putDouble("size", fileSize);
        map.putDouble("durationSeconds", durationSeconds);
        sendEvent("onFullRecordingReady", map);
        Log.d(TAG, "📤 FULL RECORDING EVENT SENT: path=" + path + ", size=" + fileSize + ", duration=" + durationSeconds + "s");
    }

    /**
     * Send interruption event
     */
    public void sendInterruptionEvent(WritableMap interruptionData) {
        sendEvent("onInterruption", interruptionData);
    }
} 