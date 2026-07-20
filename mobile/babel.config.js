module.exports = function (api) {
  api.cache(true);
  const isProduction = process.env.BABEL_ENV === "production" || process.env.NODE_ENV === "production";
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      // PRIVACY backstop (SEC-013): strip console.log/debug/info from release
      // bundles so stray logging can never leak user content to device logs.
      // warn/error are kept for crash triage.
      ...(isProduction ? [["transform-remove-console", { exclude: ["error", "warn"] }]] : []),
      "react-native-reanimated/plugin",
    ],
  };
};
