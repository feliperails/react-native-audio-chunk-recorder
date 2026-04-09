/**
 * Error tracking provider interface and implementations
 * Supports Sentry and other error tracking services
 */
export interface ErrorTracker {
    captureException: (error: Error, context?: Record<string, any>) => void;
    captureMessage: (message: string, level?: "info" | "warning" | "error") => void;
    setUser: (userId: string) => void;
    setTag: (key: string, value: string) => void;
    setContext: (name: string, context: Record<string, any>) => void;
    addBreadcrumb: (breadcrumb: {
        message: string;
        category?: string;
        level?: "info" | "warning" | "error";
        data?: Record<string, any>;
    }) => void;
}
/**
 * No-op error tracker for when no error tracking is configured
 */
export declare const noopErrorTracker: ErrorTracker;
/**
 * Sentry error tracker implementation
 * Requires @sentry/react-native to be installed
 */
export declare const createSentryErrorTracker: (dsn: string) => ErrorTracker;
/**
 * Console error tracker for development/debugging
 */
export declare const createConsoleErrorTracker: () => ErrorTracker;
