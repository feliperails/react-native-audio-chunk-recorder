"use strict";
/**
 * Core types and interfaces for react-native-audio-chunk-recorder
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChunkUri = void 0;
// Utility function to convert path to URI when needed
const getChunkUri = (chunk) => {
    return chunk.path.startsWith("file://") ? chunk.path : `file://${chunk.path}`;
};
exports.getChunkUri = getChunkUri;
