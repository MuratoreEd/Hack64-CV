// THE version of the whole project. Everything that displays or reports a
// version reads it from here: the HUD, the bridge banner, the exe banner and
// its /iwv-health response. `package.json` and `bridge/package.json` must
// repeat it (npm insists on a literal), and `src/version.test.ts` fails if
// they ever drift — v1.0.0 sat in package.json across every behavioural
// change up to the v1.1.0 tag precisely because nothing checked.
//
// Bumping: change it here, change both package.json files, add a CHANGELOG.md
// entry.
export const APP_VERSION = "1.2.0";
