// LEG-016: regenerate the open-source attribution data for the web bundle.
// Run `npm run licenses:generate` from the repo root after dependency changes
// and commit the refreshed src/data/oss-licenses.json (mirror of the mobile
// generator in mobile/scripts/generate-oss-licenses.mjs — the apps share no
// code). Production deps only: devDependencies never ship.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(repoRoot, "src/data/oss-licenses.json");

const raw = execSync("npx license-checker --production --json", {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const checker = JSON.parse(raw);

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

const self = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const entries = Object.entries(checker)
  .filter(([id]) => !id.startsWith(`${self.name}@`))
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
