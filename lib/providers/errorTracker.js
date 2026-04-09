"use strict";
/**
 * Error tracking provider interface and implementations
 * Supports Sentry and other error tracking services
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConsoleErrorTracker = exports.createSentryErrorTracker = exports.noopErrorTracker = void 0;
/**
 * No-op error tracker for when no error tracking is configured
 */
exports.noopErrorTracker = {
    captureException: () => { },
    captureMessage: () => { },
    setUser: () => { },
    setTag: () => { },
    setContext: () => { },
    addBreadcrumb: () => { },
};
/**
 * Sentry error tracker implementation
 * Requires @sentry/react-native to be installed
 */
const createSentryErrorTracker = (dsn) => {
    let Sentry = null;
    try {
        Sentry = require("@sentry/react-native");
        Sentry.init({ dsn });
    }
    catch (error) {
        console.warn("Sentry not available, falling back to no-op error tracker");
        return exports.noopErrorTracker;
    }
    return {
        captureException: (error, context) => {
            if (context) {
                Sentry.setContext("audio_recorder", context);
            }
            Sentry.captureException(error);
        },
        captureMessage: (message, level = "info") => {
            Sentry.captureMessage(message, level);
        },
        setUser: (userId) => {
            Sentry.setUser({ id: userId });
        },
        setTag: (key, value) => {
            Sentry.setTag(key, value);
        },
        setContext: (name, context) => {
            Sentry.setContext(name, context);
        },
        addBreadcrumb: (breadcrumb) => {
            Sentry.addBreadcrumb({
                message: breadcrumb.message,
                category: breadcrumb.category || "audio_recorder",
                level: breadcrumb.level || "info",
                data: breadcrumb.data,
            });
        },
    };
};
exports.createSentryErrorTracker = createSentryErrorTracker;
/**
 * Console error tracker for development/debugging
 */
const createConsoleErrorTracker = () => {
    return {
        captureException: (error, context) => {
            console.error("[AudioRecorder Error]", error);
            if (context) {
                console.error("[AudioRecorder Context]", context);
            }
        },
        captureMessage: (message, level = "info") => {
            const logMethod = level === "error"
                ? console.error
                : level === "warning"
                    ? console.warn
                    : console.log;
            logMethod(`[AudioRecorder ${level.toUpperCase()}]`, message);
        },
        setUser: (userId) => {
            console.log("[AudioRecorder] Set user:", userId);
        },
        setTag: (key, value) => {
            console.log(`[AudioRecorder] Set tag ${key}:`, value);
        },
        setContext: (name, context) => {
            console.log(`[AudioRecorder] Set context ${name}:`, context);
        },
        addBreadcrumb: (breadcrumb) => {
            console.log(`[AudioRecorder Breadcrumb] ${breadcrumb.category || "audio_recorder"}:`, breadcrumb.message, breadcrumb.data);
        },
    };
};
exports.createConsoleErrorTracker = createConsoleErrorTracker;
