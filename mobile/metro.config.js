// Metro config for the Expo app. Extends Expo's defaults and adds an explicit
// web alias so `react-native` resolves to `react-native-web` in the web bundle
// (without this, raw RN internals like Libraries/Utilities/Platform get pulled
// into the web graph and fail to resolve).
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver = config.resolver || {};
config.resolver.platforms = ["ios", "android", "native", "web"];

const ALIAS = {
  "react-native$": "react-native-web",
};

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && ALIAS[`${moduleName}$`]) {
    return context.resolveRequest(context, ALIAS[`${moduleName}$`], platform);
  }
  if (upstreamResolveRequest) {
    return upstreamResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
