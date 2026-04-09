/**
 * Simple StateManager implementation using in-memory storage
 * For apps that don't use external state management libraries
 */
import type { StateManager } from '../types';
export declare const createSimpleStateManager: () => StateManager;
