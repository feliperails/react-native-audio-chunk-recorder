/**
 * Core audio recorder hook - modular and framework-agnostic
 * This is the main hook that would be part of the NPM module
 */
import type { AudioRecorderCoreOptions, AudioRecorderCoreReturn } from "../types";
export declare const useAudioRecorderCore: (options?: AudioRecorderCoreOptions) => AudioRecorderCoreReturn;
