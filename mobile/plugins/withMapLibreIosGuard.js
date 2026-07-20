// The @maplibre/maplibre-react-native config plugin unconditionally injects
// `$MLRN.post_install(installer)` into the iOS Podfile — but this repo
// UNLINKS MapLibre on iOS (react-native.config.js: iOS renders Apple Maps via
// react-native-maps; only Android uses MapLibre). With the pod never loaded,
// $MLRN is nil and `pod install` dies with
// "undefined method 'post_install' for nil".
//
// Fix: prepend a no-op $MLRN fallback at the top of the Podfile. This is
// order-independent w.r.t. the maplibre plugin's own Podfile mod (a string
// replace of its generated line is not — mods don't run in plugins-array
// order). If MapLibre ever IS linked on iOS, its own scripts define/overwrite
// $MLRN before the post_install hook runs, so the real implementation wins.
const { withPodfile } = require("@expo/config-plugins");

const TAG = "withMapLibreIosGuard";
const SNIPPET = `# @generated ${TAG} — MapLibre is unlinked on iOS, so the $MLRN global its
# generated post_install line expects is never defined. Provide a no-op fallback.
unless $MLRN
  $MLRN = Object.new
  def $MLRN.post_install(installer); end
end
`;

module.exports = (config) =>
  withPodfile(config, (c) => {
    if (!c.modResults.contents.includes(TAG)) {
      c.modResults.contents = SNIPPET + "\n" + c.modResults.contents;
    }
    return c;
  });
