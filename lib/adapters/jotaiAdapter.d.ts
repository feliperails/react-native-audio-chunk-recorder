/**
 * Jotai adapter for StateManager interface
 * For apps that use Jotai for state management
 */
import type { StateManager } from '../types';
interface Atom<T> {
    read: (get: any) => T;
    write: (get: any, set: any, update: T) => void;
}
interface JotaiStore {
    get: <T>(atom: Atom<T>) => T;
    set: <T>(atom: Atom<T>, value: T) => void;
    sub: (atom: any, listener: () => void) => () => void;
}
export declare const createJotaiStateManager: (store: JotaiStore, atoms: Record<string, Atom<any>>) => StateManager;
export {};
