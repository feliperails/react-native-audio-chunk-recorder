"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.audioManager = void 0;
const NativeAudioChunkRecorder_1 = require("../NativeAudioChunkRecorder");
/**
 * Global Audio Manager - Coordinates all audio hooks to prevent conflicts
 *
 * This manager ensures that only one audio activity (recording or monitoring)
 * can be active at a time, preventing "Recording is already in progress" errors.
 */
class AudioManager {
    constructor() {
        this.isRecording = false;
        this.isMonitoring = false;
        this.listeners = new Set();
        this.nativeService = null;
        this.initializationPromise = this.initializeNativeService();
    }
    static getInstance() {
        if (!AudioManager.instance) {
            AudioManager.instance = new AudioManager();
        }
        return AudioManager.instance;
    }
    async initializeNativeService() {
        try {
            this.nativeService = NativeAudioChunkRecorder_1.NativeAudioChunkRecorder;
            const isAvailable = await this.nativeService.isAvailable();
            if (!isAvailable) {
                console.error("AudioManager: Native service not available");
            }
        }
        catch (error) {
            console.error("AudioManager: Failed to initialize native service:", error);
        }
    }
    async ensureInitialized() {
        await this.initializationPromise;
        if (!this.nativeService) {
            throw new Error("AudioManager: Native service not available");
        }
    }
    /**
     * Start recording - will stop monitoring if active
     */
    async startRecording(options) {
        console.log("AudioManager: 🚀 startRecording called");
        await this.ensureInitialized();
        if (this.isRecording) {
            console.log("AudioManager: ⚠️ Already recording, skipping start request");
            return "Already recording";
        }
        // Stop monitoring if active
        if (this.isMonitoring) {
            console.log("AudioManager: 🛑 Stopping monitoring before starting recording");
            await this.stopMonitoring();
        }
        try {
            const result = await this.nativeService.startRecording(options);
            this.isRecording = true;
            this.notifyListeners("recording", true);
            console.log("AudioManager: 🚀 Recording started successfully:", result);
            return result;
        }
        catch (error) {
            console.error("AudioManager: ❌ Start recording failed:", error);
            throw error;
        }
    }
    /**
     * Start monitoring - will fail if recording is active
     */
    async startMonitoring(options) {
        console.log("AudioManager: 🚀 startMonitoring called");
        await this.ensureInitialized();
        if (this.isMonitoring) {
            console.log("AudioManager: ⚠️ Already monitoring, skipping start request");
            return "Already monitoring";
        }
        if (this.isRecording) {
            const error = "AudioManager: Recording in progress. Stop recording first.";
            console.error(error);
            throw new Error(error);
        }
        try {
            const result = await this.nativeService.startRecording(options);
            this.isMonitoring = true;
            this.notifyListeners("monitoring", true);
            console.log("AudioManager: 🚀 Monitoring started successfully:", result);
            return result;
        }
        catch (error) {
            console.error("AudioManager: ❌ Start monitoring failed:", error);
            throw error;
        }
    }
    /**
     * Stop recording
     */
    async stopRecording() {
        console.log("AudioManager: 🛑 stopRecording called");
        await this.ensureInitialized();
        if (!this.isRecording) {
            console.log("AudioManager: ⚠️ Not recording, skipping stop request");
            return "Not recording";
        }
        try {
            const result = await this.nativeService.stopRecording();
            this.isRecording = false;
            this.notifyListeners("recording", false);
            console.log("AudioManager: 🛑 Recording stopped successfully:", result);
            return result;
        }
        catch (error) {
            console.error("AudioManager: ❌ Stop recording failed:", error);
            throw error;
        }
    }
    /**
     * Stop monitoring
     */
    async stopMonitoring() {
        console.log("AudioManager: 🛑 stopMonitoring called");
        await this.ensureInitialized();
        if (!this.isMonitoring) {
            console.log("AudioManager: ⚠️ Not monitoring, skipping stop request");
            return "Not monitoring";
        }
        try {
            const result = await this.nativeService.stopRecording();
            this.isMonitoring = false;
            this.notifyListeners("monitoring", false);
            console.log("AudioManager: 🛑 Monitoring stopped successfully:", result);
            return result;
        }
        catch (error) {
            console.error("AudioManager: ❌ Stop monitoring failed:", error);
            throw error;
        }
    }
    /**
     * Get current state
     */
    getState() {
        return {
            isRecording: this.isRecording,
            isMonitoring: this.isMonitoring,
            hasActiveAudio: this.isRecording || this.isMonitoring,
        };
    }
    /**
     * Add listener for state changes
     */
    addListener(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /**
     * Notify all listeners of state changes
     */
    notifyListeners(type, active) {
        console.log(`AudioManager: 📢 Notifying listeners - ${type}: ${active}`);
        this.listeners.forEach((listener) => {
            try {
                listener(type, active);
            }
            catch (error) {
                console.error("AudioManager: Error in listener:", error);
            }
        });
    }
    /**
     * Force stop all audio activities
     */
    async forceStopAll() {
        console.log("AudioManager: 🚨 Force stopping all audio activities");
        if (this.isRecording) {
            await this.stopRecording();
        }
        if (this.isMonitoring) {
            await this.stopMonitoring();
        }
    }
    /**
     * Cleanup - call when app is shutting down
     */
    cleanup() {
        console.log("AudioManager: 🧹 Cleaning up");
        this.listeners.clear();
        this.isRecording = false;
        this.isMonitoring = false;
    }
}
// Export singleton instance
exports.audioManager = AudioManager.getInstance();
