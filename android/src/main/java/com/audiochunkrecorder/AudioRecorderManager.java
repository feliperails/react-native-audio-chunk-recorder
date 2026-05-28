package com.audiochunkrecorder;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * AudioRecorderManager - Core audio recording functionality
 *
 * Captures a single continuous PCM stream from one AudioRecord and slices it
 * into chunk WAV files in software, without ever stopping the mic between
 * chunks. Also accumulates the full stream so a single complete WAV can be
 * emitted on stop.
 */
public class AudioRecorderManager {
    private static final String TAG = "AudioRecorderManager";

    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private static final int BYTES_PER_SAMPLE = 2; // 16-bit mono
    private static final double AUDIO_LEVEL_DELTA = 0.02;

    private final EventEmitter eventEmitter;
    private final FileManager fileManager;

    private AudioRecord audioRecord;
    private volatile boolean isRecording = false;
    private volatile boolean isPaused = false;
    private volatile boolean isPreviewActive = false;
    private volatile boolean isAudioLevelMonitoring = false;
    private final AtomicInteger currentChunkIndex = new AtomicInteger(0);
    private double chunkDuration = 30.0;
    private int currentSampleRate = 16000;
    private long chunkSizeBytes = 0; // bytes per chunk based on sampleRate * chunkDuration

    // Native max-duration enforcement. iOS has its own dispatch_source_t-based
    // tracker; Android historically relied on a JS setInterval which freezes
    // alongside the bridge in background. We mirror iOS here by counting PCM
    // bytes against a precomputed ceiling.
    private double maxDurationSeconds = 0;
    private long maxDurationBytes = 0; // 0 = unlimited
    private final java.util.concurrent.atomic.AtomicLong totalBytesRecorded =
            new java.util.concurrent.atomic.AtomicLong(0);

    private long recordingStartTime = 0;
    private long currentChunkStartTime = 0;

    // Single rolling buffer for the active chunk being filled.
    private ByteArrayOutputStream chunkBuffer;
    // Full-session buffer (mirrors all PCM written, regardless of chunk slicing).
    private ByteArrayOutputStream fullBuffer;
    private final Object audioDataLock = new Object();

    private ExecutorService recorderExecutor;
    private volatile double lastAudioLevel = 0.0;

    public AudioRecorderManager(EventEmitter eventEmitter, FileManager fileManager) {
        this.eventEmitter = eventEmitter;
        this.fileManager = fileManager;
    }

    /* ==============================================================
     *                PUBLIC API
     * ============================================================== */

    public void startRecording(int sampleRate, double chunkDuration, double maxDurationSeconds) throws Exception {
        if (isRecording) {
            throw new IllegalStateException("Recording is already in progress");
        }

        boolean levelMonitoring = chunkDuration < 1.0;
        this.chunkDuration = chunkDuration;
        this.currentSampleRate = sampleRate;
        this.chunkSizeBytes = levelMonitoring
                ? 0
                : (long) (sampleRate * BYTES_PER_SAMPLE * chunkDuration);
        this.isAudioLevelMonitoring = levelMonitoring;
        this.maxDurationSeconds = maxDurationSeconds;
        this.maxDurationBytes = (maxDurationSeconds > 0 && !levelMonitoring)
                ? (long) (sampleRate * BYTES_PER_SAMPLE * maxDurationSeconds)
                : 0;
        this.totalBytesRecorded.set(0);

        Log.d(TAG, "startRecording sampleRate=" + sampleRate
                + " chunkDuration=" + chunkDuration
                + " chunkSizeBytes=" + chunkSizeBytes
                + " maxDurationSeconds=" + maxDurationSeconds
                + " maxDurationBytes=" + maxDurationBytes
                + " levelMonitoring=" + levelMonitoring);

        if (currentChunkIndex.get() == 0) {
            currentChunkIndex.set(1);
        }

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

        // AudioRecord may silently fall back to a hardware-supported rate
        // (e.g. requested 44100 → granted 48000). Trust the granted rate
        // for both the WAV header and chunk slicing, otherwise tagged-vs-
        // actual rate mismatch stretches playback length (60s → ~65s when
        // 44100 is written into a header for 48000 samples).
        int grantedRate = audioRecord.getSampleRate();
        if (grantedRate > 0 && grantedRate != sampleRate) {
            Log.w(TAG, "Requested sampleRate=" + sampleRate + " but hardware granted " + grantedRate);
            this.currentSampleRate = grantedRate;
            if (!levelMonitoring) {
                this.chunkSizeBytes = (long) (grantedRate * BYTES_PER_SAMPLE * chunkDuration);
                if (maxDurationSeconds > 0) {
                    this.maxDurationBytes = (long) (grantedRate * BYTES_PER_SAMPLE * maxDurationSeconds);
                }
            }
        }

        isRecording = true;
        isPaused = false;

        recordingStartTime = System.currentTimeMillis();
        currentChunkStartTime = recordingStartTime;

        synchronized (audioDataLock) {
            chunkBuffer = levelMonitoring ? null : new ByteArrayOutputStream();
            fullBuffer = levelMonitoring ? null : new ByteArrayOutputStream();
        }

        startCaptureLoop(bufferSize);
        eventEmitter.sendStateChangeEvent(isRecording, isPaused);
    }

    public void stopRecording() {
        if (!isRecording) return;

        Log.d(TAG, "Stopping recording...");
        try {
            // 1) Stop capture loop and the mic.
            isRecording = false;
            if (audioRecord != null) {
                try { audioRecord.stop(); } catch (Exception ignored) {}
            }
            stopCaptureLoop();

            if (audioRecord != null && !isPreviewActive) {
                audioRecord.release();
                audioRecord = null;
            }

            // 2) Flush remaining chunk bytes as the final chunk.
            flushFinalChunk();

            // 3) Emit the full recording.
            emitFullRecording();

            isPaused = false;
            eventEmitter.sendStateChangeEvent(isRecording, isPaused);
            Log.d(TAG, "Recording stopped successfully");
        } catch (Exception e) {
            Log.e(TAG, "Error stopping recording", e);
            eventEmitter.sendErrorEvent("Failed to stop recording: " + e.getMessage());
        }
    }

    public void pauseRecording() {
        if (!isRecording || isPaused) return;
        try {
            if (audioRecord != null) audioRecord.stop();
            isPaused = true;
            eventEmitter.sendStateChangeEvent(isRecording, isPaused);
        } catch (Exception e) {
            Log.e(TAG, "Error pausing recording", e);
            eventEmitter.sendErrorEvent("Failed to pause recording: " + e.getMessage());
        }
    }

    public void resumeRecording() {
        if (!isRecording || !isPaused) return;
        try {
            if (audioRecord != null) audioRecord.startRecording();
            isPaused = false;
            eventEmitter.sendStateChangeEvent(isRecording, isPaused);
        } catch (Exception e) {
            Log.e(TAG, "Error resuming recording", e);
            eventEmitter.sendErrorEvent("Failed to resume recording: " + e.getMessage());
        }
    }

    public void cleanup() {
        Log.d(TAG, "Cleaning up AudioRecorderManager...");
        try {
            isRecording = false;
            isPreviewActive = false;
            stopCaptureLoop();

            if (audioRecord != null) {
                audioRecord.release();
                audioRecord = null;
            }

            synchronized (audioDataLock) {
                closeQuietly(chunkBuffer);
                closeQuietly(fullBuffer);
                chunkBuffer = null;
                fullBuffer = null;
            }
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

    public void resetChunkIndex() { currentChunkIndex.set(1); }

    public String getAudioRecordState() {
        if (audioRecord == null) return "null";
        try {
            int state = audioRecord.getState();
            switch (state) {
                case AudioRecord.STATE_INITIALIZED: return "INITIALIZED";
                case AudioRecord.STATE_UNINITIALIZED: return "UNINITIALIZED";
                default: return "UNKNOWN(" + state + ")";
            }
        } catch (Exception e) {
            return "ERROR(" + e.getMessage() + ")";
        }
    }

    /* ==============================================================
     *                AUDIO LEVEL PREVIEW
     * ============================================================== */

    public void startAudioLevelPreview() throws Exception {
        if (isRecording) throw new IllegalStateException("Cannot start preview while recording");
        if (isPreviewActive) return;

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
        isPreviewActive = true;
        startCaptureLoop(bufferSize);
    }

    public void stopAudioLevelPreview() {
        if (audioRecord != null && !isRecording) {
            isPreviewActive = false;
            stopCaptureLoop();
            audioRecord.release();
            audioRecord = null;
        }
    }

    /* ==============================================================
     *                PRIVATE IMPLEMENTATION
     * ============================================================== */

    private void startCaptureLoop(int bufferSize) {
        if (recorderExecutor == null || recorderExecutor.isShutdown()) {
            recorderExecutor = Executors.newSingleThreadExecutor();
        }
        final short[] buffer = new short[Math.max(256, bufferSize)];

        recorderExecutor.execute(() -> {
            Log.d(TAG, "Capture loop started");
            int loopCount = 0;
            while (isRecording || isPreviewActive) {
                loopCount++;

                if ((isPaused && isRecording) || audioRecord == null) {
                    try { Thread.sleep(20); } catch (InterruptedException ignored) { break; }
                    continue;
                }

                int read;
                try {
                    read = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M ?
                            audioRecord.read(buffer, 0, buffer.length, AudioRecord.READ_BLOCKING) :
                            audioRecord.read(buffer, 0, buffer.length);
                } catch (Exception e) {
                    Log.e(TAG, "Error in capture loop: " + e.getMessage(), e);
                    continue;
                }

                if (read <= 0) continue;

                // Convert short[] → little-endian PCM bytes.
                ByteBuffer byteBuffer = ByteBuffer.allocate(read * BYTES_PER_SAMPLE);
                byteBuffer.order(ByteOrder.LITTLE_ENDIAN);
                for (int i = 0; i < read; i++) byteBuffer.putShort(buffer[i]);
                byte[] pcm = byteBuffer.array();

                if (isRecording && !isAudioLevelMonitoring) {
                    appendPcmAndMaybeRotate(pcm);

                    // Native max-duration enforcement — don't rely on the JS
                    // setInterval in the hook, it freezes when the OS suspends
                    // the JS thread in background.
                    if (maxDurationBytes > 0) {
                        long total = totalBytesRecorded.addAndGet(pcm.length);
                        if (total >= maxDurationBytes) {
                            final double elapsedSeconds =
                                    (double) total / (BYTES_PER_SAMPLE * currentSampleRate);
                            final double cap = maxDurationSeconds;
                            // Stop on a different thread so the join inside
                            // stopRecording() doesn't deadlock against this
                            // executor thread.
                            new Thread(() -> {
                                stopRecording();
                                eventEmitter.sendMaxDurationReachedEvent(elapsedSeconds, cap);
                            }, "audio-auto-stop").start();
                            break;
                        }
                    }
                }

                // Audio level (recording or preview).
                double sum = 0;
                for (int i = 0; i < read; i++) sum += buffer[i] * buffer[i];
                double rms = Math.sqrt(sum / read) / 32768.0;
                if (rms > 1.0) rms = 1.0;
                if (Math.abs(rms - lastAudioLevel) >= AUDIO_LEVEL_DELTA) {
                    lastAudioLevel = rms;
                    eventEmitter.sendAudioLevelEvent(rms);
                }
            }
            Log.d(TAG, "Capture loop ended after " + loopCount + " iterations");
        });
    }

    /**
     * Append PCM into the chunk buffer (and full buffer); whenever the chunk
     * buffer crosses the chunk-size threshold, slice it into a WAV file and
     * emit onChunkReady. The mic is NEVER touched here — the next chunk
     * continues seamlessly from the same continuous AudioRecord.
     */
    private void appendPcmAndMaybeRotate(byte[] pcm) {
        synchronized (audioDataLock) {
            if (chunkBuffer == null || fullBuffer == null) return;
            try {
                chunkBuffer.write(pcm);
                fullBuffer.write(pcm);
            } catch (IOException e) {
                Log.e(TAG, "Error writing PCM: " + e.getMessage());
                return;
            }

            // Emit chunks while we've accumulated at least one chunk's worth.
            while (chunkSizeBytes > 0 && chunkBuffer.size() >= chunkSizeBytes) {
                byte[] all = chunkBuffer.toByteArray();
                byte[] head = new byte[(int) chunkSizeBytes];
                System.arraycopy(all, 0, head, 0, head.length);

                int leftover = all.length - head.length;
                chunkBuffer.reset();
                if (leftover > 0) {
                    // ByteArrayOutputStream.write(byte[], int, int) does not throw.
                    chunkBuffer.write(all, head.length, leftover);
                }

                int idx = currentChunkIndex.getAndIncrement();
                long startedAt = currentChunkStartTime;
                currentChunkStartTime = System.currentTimeMillis();
                emitChunk(head, idx, startedAt, false);
            }
        }
    }

    private void flushFinalChunk() {
        byte[] tail;
        int idx;
        long startedAt;
        synchronized (audioDataLock) {
            if (chunkBuffer == null || chunkBuffer.size() == 0) {
                closeQuietly(chunkBuffer);
                chunkBuffer = null;
                return;
            }
            tail = chunkBuffer.toByteArray();
            chunkBuffer.reset();
            closeQuietly(chunkBuffer);
            chunkBuffer = null;
            idx = currentChunkIndex.getAndIncrement();
            startedAt = currentChunkStartTime;
        }
        emitChunk(tail, idx, startedAt, true);
    }

    private void emitChunk(byte[] pcm, int index, long startedAt, boolean isLast) {
        String chunkPath = fileManager.saveChunkToFile(pcm, index, currentSampleRate);
        if (chunkPath == null) {
            eventEmitter.sendErrorEvent("Failed to save chunk " + index);
            return;
        }
        eventEmitter.sendChunkReadyEvent(chunkPath, index, startedAt, pcm.length, isLast);
    }

    private void emitFullRecording() {
        byte[] data;
        synchronized (audioDataLock) {
            if (fullBuffer == null || fullBuffer.size() == 0) {
                closeQuietly(fullBuffer);
                fullBuffer = null;
                return;
            }
            data = fullBuffer.toByteArray();
            closeQuietly(fullBuffer);
            fullBuffer = null;
        }
        String path = fileManager.saveFullRecordingToFile(data, currentSampleRate);
        if (path == null) {
            eventEmitter.sendErrorEvent("Failed to save full recording");
            return;
        }
        double duration = (data.length / (double) BYTES_PER_SAMPLE) / (double) currentSampleRate;
        eventEmitter.sendFullRecordingReadyEvent(path, recordingStartTime, data.length, duration);
    }

    private void stopCaptureLoop() {
        if (!isRecording && !isPreviewActive) {
            if (recorderExecutor != null && !recorderExecutor.isShutdown()) {
                recorderExecutor.shutdownNow();
            }
        }
    }

    private static void closeQuietly(ByteArrayOutputStream s) {
        if (s == null) return;
        try { s.close(); } catch (IOException ignored) {}
    }
}
