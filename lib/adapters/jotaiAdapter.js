"use strict";
/**
 * Jotai adapter for StateManager interface
 * For apps that use Jotai for state management
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJotaiStateManager = void 0;
const createJotaiStateManager = (store, atoms) => {
    return {
        getState: (key) => {
            const atom = atoms[key];
            if (!atom) {
                throw new Error(`No atom found for key: ${key}`);
            }
            return store.get(atom);
        },
        setState: (key, value) => {
            const atom = atoms[key];
            if (!atom) {
                throw new Error(`No atom found for key: ${key}`);
            }
            store.set(atom, value);
        },
        subscribe: (key, callback) => {
            const atom = atoms[key];
            if (!atom) {
                throw new Error(`No atom found for key: ${key}`);
            }
            return store.sub(atom, () => {
                const value = store.get(atom);
                callback(value);
            });
        }
    };
};
exports.createJotaiStateManager = createJotaiStateManager;
// Example usage in an app:
/*
import { atom, useAtom } from 'jotai';
import { createJotaiStateManager } from 'react-native-audio-chunk-recorder/adapters/jotaiAdapter';

const audioInterruptionAtom = atom(false);
const audioAlertActiveAtom = atom(false);

const atoms = {
  'audioInterruption': audioInterruptionAtom,
  'audioAlertActive': audioAlertActiveAtom
};

const stateManager = createJotaiStateManager(store, atoms);
*/
