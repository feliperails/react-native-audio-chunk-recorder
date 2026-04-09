"use strict";
/**
 * Simple StateManager implementation using in-memory storage
 * For apps that don't use external state management libraries
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSimpleStateManager = void 0;
const createSimpleStateManager = () => {
    const state = new Map();
    const listeners = new Map();
    return {
        getState: (key) => {
            return state.get(key);
        },
        setState: (key, value) => {
            const prevValue = state.get(key);
            if (prevValue === value)
                return; // Avoid unnecessary updates
            state.set(key, value);
            // Notify listeners
            const keyListeners = listeners.get(key);
            if (keyListeners) {
                keyListeners.forEach(listener => {
                    try {
                        listener(value);
                    }
                    catch (error) {
                        console.error(`Error in state listener for key "${key}":`, error);
                    }
                });
            }
        },
        subscribe: (key, callback) => {
            if (!listeners.has(key)) {
                listeners.set(key, new Set());
            }
            const keyListeners = listeners.get(key);
            keyListeners.add(callback);
            // Call immediately with current value
            const currentValue = state.get(key);
            if (currentValue !== undefined) {
                callback(currentValue);
            }
            // Return unsubscribe function
            return () => {
                keyListeners.delete(callback);
                if (keyListeners.size === 0) {
                    listeners.delete(key);
                }
            };
        }
    };
};
exports.createSimpleStateManager = createSimpleStateManager;
