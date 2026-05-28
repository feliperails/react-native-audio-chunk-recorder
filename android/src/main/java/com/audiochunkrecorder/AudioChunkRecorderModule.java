package com.audiochunkrecorder;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import androidx.core.app.ActivityCompat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.File;
import java.io.IOException;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Queue;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import com.audiochunkrecorder.AudioRecorderManager;

/**
 * AudioChunkRecorderModule - React Native Bridge
 * 
 * Main module that exposes the API to JavaScript and coordinates
 * the audio recording functionality through specialized components.
 */
public class AudioChunkRecorderModule extends ReactContextBaseJavaModule {
    private static final String TAG = "AudioChunkRecorder";

    // Core components
    private final AudioRecorderManager recorderManager;
    private final EventEmitter eventEmitter;
    private final PermissionManager permissionManager;
    private final FileManager fileManager;
    
    // Map pools for performance
    private final Queue<WritableMap> stateMapPool = new ConcurrentLinkedQueue<>();
    private final Queue<WritableMap> errorMapPool = new ConcurrentLinkedQueue<>();
    private final Queue<WritableMap> chunkMapPool = new ConcurrentLinkedQueue<>();

    public AudioChunkRecorderModule(ReactApplicationContext reactContext) {
        super(reactContext);
        
        // Initialize components
        this.eventEmitter = new EventEmitter(reactContext);
        this.permissionManager = new PermissionManager(reactContext);
        this.fileManager = new FileManager(reactContext);
        this.recorderManager =       new AudioRecorderManager(eventEmitter, fileManager);
        
        initializeMapPool();
        Log.i(TAG, "AudioChunkRecorderModule initialized");
    }

    @Override
    public String getName() { 
        return "AudioChunkRecorder"; 
    }

    /* ==============================================================
     *                MAP POOL MANAGEMENT
     * ============================================================== */

    private void initializeMapPool() {
        for (int i = 0; i < 5; i++) {
            stateMapPool.offer(Arguments.createMap());
            errorMapPool.offer(Arguments.createMap());
            chunkMapPool.offer(Arguments.createMap());
        }
    }

    private WritableMap getStateMap() {
        WritableMap m = stateMapPool.poll();
        return m != null ? m : Arguments.createMap();
    }

    private WritableMap getErrorMap() {
        WritableMap m = errorMapPool.poll();
        return m != null ? m : Arguments.createMap();
    }

    private WritableMap getChunkMap() {
        WritableMap m = chunkMapPool.poll();
        return m != null ? m : Arguments.createMap();
    }

    /* ==============================================================
     *                REACT NATIVE API METHODS
     * ============================================================== */

    @ReactMethod
    public void startRecording(ReadableMap options, Promise promise) {
        if (!permissionManager.hasPermission()) {
            promise.reject("permission_denied", "Audio recording permission not granted");
            return;
        }

        try {
            int sampleRate = options.hasKey("sampleRate") ? options.getInt("sampleRate") : 16000;
            double chunkDuration = options.hasKey("chunkSeconds") ? options.getDouble("chunkSeconds") : 30.0;
            // Mirror iOS: 0/absent means "no native max-duration enforcement",
            // anything > 0 caps the session at that many seconds. The JS hook
            // sends "maxRecordingDuration"; iOS already reads the same key.
            double maxDuration = options.hasKey("maxRecordingDuration")
                    ? options.getDouble("maxRecordingDuration") : 0.0;

            recorderManager.startRecording(sampleRate, chunkDuration, maxDuration);
            promise.resolve("Recording started");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start recording", e);
            promise.reject("start_failed", e.getMessage());
        }
    }

    @ReactMethod
    public void stopRecording(Promise promise) {
        try {
            recorderManager.stopRecording();
            promise.resolve("Recording stopped");
        } catch (Exception e) {
            Log.e(TAG, "Error stopping recording", e);
            promise.reject("stop_failed", e.getMessage());
        }
    }

    @ReactMethod
    public void pauseRecording(Promise promise) {
        try {
            recorderManager.pauseRecording();
            promise.resolve("Recording paused");
        } catch (Exception e) {
            promise.reject("pause_failed", e.getMessage());
        }
    }

    @ReactMethod
    public void resumeRecording(Promise promise) {
        try {
            recorderManager.resumeRecording();
            promise.resolve("Recording resumed");
        } catch (Exception e) {
            promise.reject("resume_failed", e.getMessage());
        }
    }

    /* ==============================================================
     *                QUERY METHODS
     * ============================================================== */

    @ReactMethod
    public void checkPermissions(Promise promise) { 
        promise.resolve(permissionManager.hasPermission()); 
    }

    @ReactMethod
    public void isAvailable(Promise promise) { 
        promise.resolve(true); 
    }

    @ReactMethod
    public void isRecording(Promise promise) { 
        promise.resolve(recorderManager.isRecording()); 
    }

    @ReactMethod
    public void isPaused(Promise promise) { 
        promise.resolve(recorderManager.isPaused()); 
    }

    @ReactMethod
    public void getAudioLevel(Promise promise) { 
        promise.resolve(recorderManager.getAudioLevel()); 
    }

    @ReactMethod
    public void hasAudioSession(Promise promise) { 
        promise.resolve(true); 
    }

    @ReactMethod
    public void getCurrentChunkIndex(Promise promise) { 
        promise.resolve(recorderManager.getCurrentChunkIndex()); 
    }

    @ReactMethod
    public void getChunkDuration(Promise promise) { 
        promise.resolve(recorderManager.getChunkDuration()); 
    }

    @ReactMethod
    public void getRecordingState(Promise promise) {
        WritableMap state = getStateMap();
        state.putBoolean("isRecording", recorderManager.isRecording());
        state.putBoolean("isPaused", recorderManager.isPaused());
        state.putBoolean("isAvailable", true);
        state.putBoolean("hasPermission", permissionManager.hasPermission());
        state.putInt("currentChunkIndex", recorderManager.getCurrentChunkIndex());
        state.putDouble("chunkDuration", recorderManager.getChunkDuration());
        state.putDouble("audioLevel", recorderManager.getAudioLevel());
        promise.resolve(state);
    }

    @ReactMethod
    public void clearAllChunkFiles(Promise promise) {
        try {
            int deletedCount = fileManager.clearAllChunkFiles();
            recorderManager.resetChunkIndex();
            promise.resolve("Deleted " + deletedCount + " chunk files");
        } catch (Exception e) {
            promise.reject("FILE_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void getModuleInfo(Promise promise) {
        WritableMap info = Arguments.createMap();
        info.putString("name", "AudioChunkRecorder");
        info.putString("version", "1.0.0-refactored");
        info.putString("platform", "Android");
        info.putBoolean("isSimplified", false);
        info.putBoolean("hasAudioLevelMonitoring", true);
        info.putBoolean("hasChunkSupport", true);
        info.putInt("sampleRate", 16000);
        info.putString("audioFormat", "PCM_16BIT");
        info.putString("channelConfig", "MONO");
        promise.resolve(info);
    }

    /* ==============================================================
     *                MODULE CLEANUP
     * ============================================================== */

    @Override
    public void onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy();
        cleanup();
    }

    private void cleanup() {
        try {
            recorderManager.cleanup();
            stateMapPool.clear(); 
            errorMapPool.clear(); 
            chunkMapPool.clear();
        } catch (Exception e) {
            Log.e(TAG, "cleanup error", e);
        }
    }
}
