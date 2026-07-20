// LEG-016: regenerate the open-source attribution data shipped in the app.
//
// Run `npm run licenses:generate` from mobile/ after any dependency change,
// and commit the refreshed src/design/data/oss-licenses.json. The file is
// COMMITTED (not built on the fly) because it must ship inside the binary —
// a build step that silently no-oped would leave the store build without the
// attributions the OFL-1.1 fonts and Apache-2.0 packages require.
//
// Kept to production deps: devDependencies (eas-cli etc.) never ship.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(mobileRoot, "src/design/data/oss-licenses.json");

const raw = execSync("npx license-checker --production --json", {
  cwd: mobileRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const checker = JSON.parse(raw);

// First "Copyright ..." line of the package's licence file, when one exists —
// the attribution line MIT/BSD/OFL actually ask for, without shipping 900
// full licence texts in the binary.
function copyrightLine(licenseFile) {
  if (!licenseFile || !existsSync(licenseFile)) return null;
  try {
    const text = readFileSync(licenseFile, "utf8");
    const m = text.match(/^.*copyright.*$/im);
    return m ? m[0].trim().replace(/^[#*\s]+/, "").slice(0, 200) : null;
  } catch {
    return null;
  }
}

const self = JSON.parse(readFileSync(join(mobileRoot, "package.json"), "utf8"));
const entries = Object.entries(checker)
  .filter(([id]) => !id.startsWith(`${self.name}@`)) // exclude the app itself
  .map(([id, info]) => {
    const at = id.lastIndexOf("@");
    return {
      name: id.slice(0, at),
      version: id.slice(at + 1),
      license: info.licenses ?? "UNKNOWN",
      copyright: copyrightLine(info.licenseFile),
      repository: info.repository ?? null,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(
  outPath,
  JSON.stringify({ generatedFrom: "license-checker --production", packages: entries }, null, 2) + "\n",
);
console.log(`${entries.length} packages -> ${outPath}`);
