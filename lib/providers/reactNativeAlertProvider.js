"use strict";
/**
 * Default AlertProvider implementation for React Native
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.reactNativeAlertProvider = void 0;
const react_native_1 = require("react-native");
exports.reactNativeAlertProvider = {
    showAlert: (title, message, buttons) => {
        // Transform our AlertButton interface to React Native's AlertButton
        const rnButtons = buttons.map(button => ({
            text: button.text,
            onPress: button.onPress,
            style: button.style
        }));
        react_native_1.Alert.alert(title, message, rnButtons, {
            cancelable: false
        });
    }
};
