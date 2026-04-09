package com.audiochunkrecorder;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Timer;
import java.util.TimerTask;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * AudioRecorderManager - Core audio recording functionality
 * 
 * Handles all audio recording operations including:
 * - Audio capture and processing
 * - Chunk rotation and file management
 * - Audio level monitoring
 * - State management
 */
public class AudioRecorderManager {
    private static final String TAG = "AudioRecorderManager";
    
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private static final double AUDIO_LEVEL_DELTA = 0.02; // threshold for emitting events

    // Core components
    private final EventEmitter eventEmitter;
    private final FileManager fileManager;

    // Recording state
    private AudioRecord audioRecord;
    private volatile boolean isRecording = false;
    private volatile boolean isPaused = false;
    private volatile boolean isPreviewActive = false;
    private volatile boolean isAudioLevelMonitoring = false;
    private final AtomicInteger currentChunkIndex = new AtomicInteger(0);
    private double chunkDuration = 30.0; // seconds

    // Chunk timing tracking
    private long currentChunkStartTime = 0;
    private long recordingStartTime = 0;

    // Audio processing
    private ByteArrayOutputStream audioDataBuffer;
    private final Object audioDataLock = new Object();
    private ExecutorService recorderExecutor;
    private Timer chunkTimer;

    // Audio level
    private volatile double lastAudioLevel = 0.0; // 0.0 – 1.0

    public AudioRecorderManager(EventEmitter eventEmitter, FileManager fileManager) {
        this.eventEmitter = eventEmitter;
        this.fileManager = fileManager;
    }

    /* ==============================================================
     *                PUBLIC API
     * ============================================================== */

    /**
     * Start recording with specified parameters
     */
    public void startRecording(int sampleRate, double chunkDuration) throws Exception {
        if (isRecording) {
            throw new IllegalStateException("Recording is already in progress");
        }

        // Check if this is for audio level monitoring (very short chunks)
        boolean isAudioLevelMonitoring = chunkDuration < 1.0; // Less than 1 second
        
        if (isAudioLevelMonitoring) {
            Log.d(TAG, "Starting audio level monitoring mode (chunk duration: " + chunkDuration + "s)");
        } else {
            Log.d(TAG, "Starting normal recording mode (chunk duration: " + chunkDuration + "s)");
        }

        this.chunkDuration = chunkDuration;
        startNewChunk(sampleRate, isAudioLevelMonitoring);
    }

    /**
     * Stop recording
     */
    public void stopRecording() {
        if (!isRecording) {
            return;
        }

        Log.d(TAG, "Stopping recording...");

        try {
            // 1) Finalize current chunk (even if we were paused) and mark as last chunk
            finishCurrentChunk(true);

            // 2) Mark recording as stopped and stop capture loop
            isRecording = false;
            stopCaptureLoop();

            // 3) Cancel any pending timers
            if (chunkTimer != null) {
                chunkTimer.cancel();
                chunkTimer = null;
            }
            
            if (audioRecord != null && !isPreviewActive) { // NEW: Only release if not in preview
                audioRecord.release();
                audioRecord = null;
            }

            isPaused = false;
            eventEmitter.sendStateChangeEvent(isRecording, isPaused);
            
            Log.d(TAG, "Recording stopped successfully");
        } catch (Exception e) {
            Log.e(TAG, "Error stopping recording", e);
            eventEmitter.sendErrorEvent("Failed to stop recording: " + e.getMessage());
        }
    }

    /**
     * Pause recording
     */
    public void pauseRecording() {
        if (!isRecording || isPaused) {
            return;
        }

        try {
            if (audioRecord != null) audioRecord.stop();
            if (chunkTimer != null) {
                chunkTimer.cancel();
                chunkTimer = null;
            }
            isPaused = true;
            eventEmitter.sendStateChangeEvent(isRecording, isPaused);
        } catch (Exception e) {
            Log.e(TAG, "Error pausing recording", e);
            eventEmitter.sendErrorEvent("Failed to pause recording: " + e.getMessage());
        }
    }

    /**
     * Resume recording
     */
    public void resumeRecording() {
        if (!isRecording || !isPaused) {
            return;
        }

        try {
            if (audioRecord != null) audioRecord.startRecording();
            isPaused = false;
            scheduleRotation(chunkDuration);
            eventEmitter.sendStateChangeEvent(isRecording, isPaused);
        } catch (Exception e) {
            Log.e(TAG, "Error resuming recording", e);
            eventEmitter.sendErrorEvent("Failed to resume recording: " + e.getMessage());
        }
    }

    /**
     * Clean up resources
     */
    public void cleanup() {
        Log.d(TAG, "Cleaning up AudioRecorderManager...");
        
        try {
            isRecording = false;
            isPreviewActive = false; // NEW: Stop preview too
            stopCaptureLoop();
            
            if (audioRecord != null) {
                audioRecord.release();
                audioRecord = null;
            }
            
            if (chunkTimer != null) {
                chunkTimer.cancel();
                chunkTimer = null;
            }
            
            synchronized (audioDataLock) {
                if (audioDataBuffer != null) {
                    try {
                        audioDataBuffer.close();
                    } catch (IOException ignored) {}
                    audioDataBuffer = null;
                }
            }
            
            Log.d(TAG, "AudioRecorderManager cleanup completed");
        } catch (Exception e) {
            Log.e(TAG, "cleanup error", e);
        }
    }

    /* ==============================================================
     *                STATE QUERIES
     * ============================================================== */

    public boolean isRecording() { return isRecording; }
    public boolean isPaused() { return isPaused; }
    public boolean isPreviewActive() { return isPreviewActive; }
    public double getAudioLevel() { return lastAudioLevel; }
    public int getCurrentChunkIndex() { return currentChunkIndex.get(); }
    public double getChunkDuration() { return chunkDuration; }

    /**
     * Reset chunk index (used when clearing files)
     */
    public void resetChunkIndex() {
        currentChunkIndex.set(1);
    }

    /**
     * Get AudioRecord state for debugging
     */
    public String getAudioRecordState() {
        if (audioRecord == null) {
            return "null";
        }
        try {
            int state = audioRecord.getState();
            switch (state) {
                case AudioRecord.STATE_INITIALIZED:
                    return "INITIALIZED";
                case AudioRecord.STATE_UNINITIALIZED:
                    return "UNINITIALIZED";
                default:
                    return "UNKNOWN(" + state + ")";
            }
        } catch (Exception e) {
            return "ERROR(" + e.getMessage() + ")";
        }
    }

    /* ==============================================================
     *                AUDIO LEVEL PREVIEW METHODS
     * ============================================================== */

    /**
     * Start audio level preview (without recording)
     */
    public void startAudioLevelPreview() throws Exception {
        if (isRecording) {
            throw new IllegalStateException("Cannot start preview while recording");
        }

        if (isPreviewActive) {
            Log.d(TAG, "Audio level preview already active");
            return;
        }

        Log.d(TAG, "Starting audio level preview...");

        // Start a minimal audio capture just for level monitoring
        int sampleRate = 16000;
        int bufferSize = AudioRecord.getMinBufferSize(sampleRate, CHANNEL_CONFIG, AUDIO_FORMAT);
        
        if (bufferSize == AudioRecord.ERROR_BAD_VALUE) {
            throw new Exception("Invalid audio configuration");
        }
        
        audioRecord = new AudioRecord(
            MediaRecorder.AudioSource.MIC,
            sampleRate,
            CHANNEL_CONFIG,
            AUDIO_FORMAT,
            bufferSize
        );
        
        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            throw new Exception("AudioRecord initialization failed");
        }
        
        audioRecord.startRecording();
        isPreviewActive = true; // NEW: Set preview flag
        startCaptureLoop(bufferSize, sampleRate);
        
        Log.d(TAG, "Audio level preview started successfully");
    }

    /**
     * Stop audio level preview
     */
    public void stopAudioLevelPreview() {
        Log.d(TAG, "Stopping audio level preview...");
        
        if (audioRecord != null && !isRecording) {
            isPreviewActive = false; // NEW: Clear preview flag
            stopCaptureLoop();
            audioRecord.release();
            audioRecord = null;
            Log.d(TAG, "Audio level preview stopped successfully");
        }
    }

    /* ==============================================================
     *                PRIVATE IMPLEMENTATION
     * ============================================================== */

    private void startNewChunk(int sampleRate, boolean isAudioLevelMonitoring) throws Exception {
        int bufferSize = AudioRecord.getMinBufferSize(sampleRate, CHANNEL_CONFIG, AUDIO_FORMAT);
        
        if (bufferSize == AudioRecord.ERROR_BAD_VALUE) {
            throw new Exception("Invalid audio configuration");
        }
        
        // Initialize chunk index to 1 if this is the first chunk
        if (currentChunkIndex.get() == 0) {
            currentChunkIndex.set(1);
            Log.d(TAG, "🚀 FIRST CHUNK: Initialized currentChunkIndex to 1");
        }
        
        Log.d(TAG, "📦 STARTING NEW CHUNK: currentChunkIndex=" + currentChunkIndex.get() + ", isAudioLevelMonitoring=" + isAudioLevelMonitoring);
        
        audioRecord = new AudioRecord(
            MediaRecorder.AudioSource.MIC,
            sampleRate,
            CHANNEL_CONFIG,
            AUDIO_FORMAT,
            bufferSize
        );
        
        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            throw new Exception("AudioRecord initialization failed");
        }
        
        audioRecord.startRecording();
        isRecording = true;
        isPaused = false;
        this.isAudioLevelMonitoring = isAudioLevelMonitoring;

        // Track chunk timing
        currentChunkStartTime = System.currentTimeMillis();
        if (recordingStartTime == 0) {
            recordingStartTime = currentChunkStartTime;
        }
        
        Log.d(TAG, "⏰ CHUNK TIMING: currentChunkStartTime=" + currentChunkStartTime + ", recordingStartTime=" + recordingStartTime);

        // Initialize audio data buffer (only for normal recording)
        if (!isAudioLevelMonitoring) {
            synchronized (audioDataLock) {
                audioDataBuffer = new ByteArrayOutputStream();
            }
        }

        startCaptureLoop(bufferSize, sampleRate);
        
        // Only schedule rotation for normal recording
        if (!isAudioLevelMonitoring) {
            Log.d(TAG, "📅 SCHEDULING ROTATION: chunkDuration=" + chunkDuration + "s for chunk " + currentChunkIndex.get());
            scheduleRotation(chunkDuration);
        }
        
        eventEmitter.sendStateChangeEvent(isRecording, isPaused);
    }

    private void startCaptureLoop(int bufferSize, int sampleRate) {
        if (recorderExecutor == null || recorderExecutor.isShutdown()) {
            recorderExecutor = Executors.newSingleThreadExecutor();
        }
        final short[] buffer = new short[Math.max(256, bufferSize)];

        recorderExecutor.execute(() -> {
            Log.d(TAG, "Capture loop started - isRecording: " + isRecording + ", isPreviewActive: " + isPreviewActive);
            
            int loopCount = 0;
            while (isRecording || isPreviewActive) {
                loopCount++;
                
                if ((isPaused && isRecording) || audioRecord == null) {
                    try {
                        Thread.sleep(20);
                    } catch (InterruptedException ignored) {
                        Log.w(TAG, "Capture loop interrupted");
                        break;
                    }
                    continue;
                }

                try {
                    int read = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M ?
                            audioRecord.read(buffer, 0, buffer.length, AudioRecord.READ_BLOCKING) :
                            audioRecord.read(buffer, 0, buffer.length);

                    if (read <= 0) {
                        Log.w(TAG, "AudioRecord.read returned: " + read + " (loop: " + loopCount + ")");
                        continue;
                    }

                    // Log every 100th iteration to track progress
                    if (loopCount % 100 == 0) {
                        Log.d(TAG, "Capture loop iteration: " + loopCount + " (read: " + read + " samples)");
                    }

                    // Collect audio data for WAV file (only when recording)
                    if (isRecording) {
                        synchronized (audioDataLock) {
                            if (audioDataBuffer != null) {
                                // Convert short[] to bytes (little-endian)
                                ByteBuffer byteBuffer = ByteBuffer.allocate(read * 2);
                                byteBuffer.order(ByteOrder.LITTLE_ENDIAN);
                                for (int i = 0; i < read; i++) {
                                    byteBuffer.putShort(buffer[i]);
                                }
                                try {
                                    audioDataBuffer.write(byteBuffer.array());
                                } catch (IOException e) {
                                    Log.e(TAG, "Error writing to audio buffer: " + e.getMessage());
                                }
                            }
                        }
                    }

                    // Calculate audio level (for both recording and preview)
                    double sum = 0;
                    for (int i = 0; i < read; i++) sum += buffer[i] * buffer[i];
                    double rms = Math.sqrt(sum / read) / 32768.0;
                    if (rms > 1.0) rms = 1.0;

                    // Always emit audio level events (for both recording and preview)
                    if (Math.abs(rms - lastAudioLevel) >= AUDIO_LEVEL_DELTA) {
                        lastAudioLevel = rms;
                        Log.d(TAG, "Emitting audio level: " + rms + " (recording: " + isRecording + ", preview: " + isPreviewActive + ", loop: " + loopCount + ")");
                        eventEmitter.sendAudioLevelEvent(rms);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error in capture loop (iteration " + loopCount + "): " + e.getMessage(), e);
                    // Don't break the loop on error, just continue
                }
            }
            
            Log.d(TAG, "Capture loop ended after " + loopCount + " iterations");
        });
    }

    private void stopCaptureLoop() {
        Log.d(TAG, "stopCaptureLoop called - isRecording: " + isRecording + ", isPreviewActive: " + isPreviewActive);
        
        // Only stop the loop if neither recording nor preview is active
        if (!isRecording && !isPreviewActive) {
            Log.d(TAG, "Stopping executor - neither recording nor preview active");
            if (recorderExecutor != null && !recorderExecutor.isShutdown()) {
                recorderExecutor.shutdownNow();
                Log.d(TAG, "Executor shutdown completed");
            }
        } else {
            Log.d(TAG, "Not stopping executor - recording: " + isRecording + ", preview: " + isPreviewActive);
        }
        
        // Clear audio data buffer (only when recording stops)
        if (!isRecording) {
            synchronized (audioDataLock) {
                if (audioDataBuffer != null) {
                    try {
                        audioDataBuffer.close();
                        Log.d(TAG, "Audio data buffer closed");
                    } catch (IOException ignored) {}
                    audioDataBuffer = null;
                }
            }
        }
    }

    private void scheduleRotation(double delaySeconds) {
        if (chunkTimer != null) chunkTimer.cancel();
        chunkTimer = new Timer();
        long delayMs = (long) (delaySeconds * 1000);
        Log.d(TAG, "⏰ TIMER SET: Scheduling rotation in " + delayMs + "ms for chunk " + currentChunkIndex.get());
        chunkTimer.schedule(new TimerTask() {
            @Override
            public void run() {
                Log.d(TAG, "🔄 TIMER FIRED: Starting rotation for chunk " + currentChunkIndex.get());
                if (isRecording && !isPaused && !isAudioLevelMonitoring) {
                    // Finish current chunk and start new one
                    rotateToNextChunk();
                } else {
                    Log.d(TAG, "⏸️ TIMER FIRED but not rotating: isRecording=" + isRecording + ", isPaused=" + isPaused + ", isAudioLevelMonitoring=" + isAudioLevelMonitoring);
                }
            }
        }, delayMs);
    }

    /**
     * Rotate to the next chunk - finish current and start new one
     */
    private void rotateToNextChunk() {
        try {
            Log.d(TAG, "🔄 ROTATING: Finishing chunk " + currentChunkIndex.get() + " and starting next");
            
            // 1. Finish current chunk
            finishCurrentChunk(false);
            
            // 2. Start new chunk with same sample rate
            int currentSampleRate = 16000; // Default fallback
            try {
                if (audioRecord != null) {
                    currentSampleRate = audioRecord.getSampleRate();
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not get current sample rate, using default");
            }
            
            startNewChunk(currentSampleRate, false);
        } catch (Exception e) {
            Log.e(TAG, "❌ ERROR in rotation: " + e.getMessage());
            eventEmitter.sendErrorEvent("Failed to rotate chunk: " + e.getMessage());
        }
    }

    private void finishCurrentChunk() {
        finishCurrentChunk(false);
    }

    private void finishCurrentChunk(boolean isStoppingRecording) {
        Log.d(TAG, "🔚 FINISHING CHUNK: currentChunkIndex=" + currentChunkIndex.get() + ", isStoppingRecording=" + isStoppingRecording);

        int chunkSampleRate = 16000;
        if (audioRecord != null) {
            try {
                chunkSampleRate = audioRecord.getSampleRate();
            } catch (Exception e) {
                Log.w(TAG, "Could not read recorder sample rate, using fallback 16000Hz");
            }
        }
        
        if (audioRecord != null) {
            audioRecord.stop();
            audioRecord.release();
            audioRecord = null;
        }
        
        if (chunkTimer != null) {
            chunkTimer.cancel();
            chunkTimer = null;
        }
        
        // Calculate chunk duration and size
        long chunkEndTime = System.currentTimeMillis();
        double actualChunkDuration = (chunkEndTime - currentChunkStartTime) / 1000.0;
        long chunkSize = 0;
        
        Log.d(TAG, "⏰ CHUNK DURATION: actualChunkDuration=" + actualChunkDuration + "s");
        
        // Save the chunk data (only for normal recording)
        if (!isAudioLevelMonitoring) {
            synchronized (audioDataLock) {
                if (audioDataBuffer != null) {
                    byte[] audioData = audioDataBuffer.toByteArray();
                    chunkSize = audioData.length;
                    
                    Log.d(TAG, "💾 SAVING CHUNK: size=" + chunkSize + " bytes, duration=" + actualChunkDuration + "s");
                    
                    // Save to file
                    String chunkPath = fileManager.saveChunkToFile(audioData, currentChunkIndex.get(), chunkSampleRate);
                    
                    // ALWAYS emit the chunk event
                    if (chunkPath != null) {
                        Log.d(TAG, "✅ EMITTING CHUNK EVENT: chunkIndex=" + currentChunkIndex.get() + ", path=" + chunkPath);
                        eventEmitter.sendChunkEvent(
                            currentChunkIndex.get(),
                            chunkPath,
                            currentChunkStartTime,
                            chunkSize
                        );
                    } else {
                        Log.e(TAG, "❌ FAILED TO SAVE CHUNK: chunkIndex=" + currentChunkIndex.get());
                        eventEmitter.sendErrorEvent("Failed to save chunk " + currentChunkIndex.get());
                    }
                    
                    // Clean up buffer
                    audioDataBuffer = null;
                } else {
                    Log.w(TAG, "⚠️ NO AUDIO DATA: audioDataBuffer is null for chunk " + currentChunkIndex.get());
                }
            }
        }
        
        // Only increment chunk index if not stopping recording
        if (!isStoppingRecording) {
            currentChunkIndex.incrementAndGet();
            Log.d(TAG, "🔢 INCREMENTED CHUNK INDEX: new currentChunkIndex=" + currentChunkIndex.get());
        }
        
        Log.d(TAG, "🏁 CHUNK FINISHED: chunkIndex=" + (isStoppingRecording ? currentChunkIndex.get() : currentChunkIndex.get() - 1));
    }
} 