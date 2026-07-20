import { Alert, ToastAndroid, Platform } from "react-native";

export const toast = {
  success(msg: string) {
    if (Platform.OS === "android") ToastAndroid.show(msg, ToastAndroid.SHORT);
    else Alert.alert("", msg);
  },
  error(msg: string) {
    if (Platform.OS === "android") ToastAndroid.show(msg, ToastAndroid.LONG);
    else Alert.alert("Error", msg);
  },
  info(msg: string) {
    if (Platform.OS === "android") ToastAndroid.show(msg, ToastAndroid.SHORT);
    else Alert.alert("", msg);
  },
};
