import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LEGAL_DOCS_VERSION } from "./legal";

/**
 * 3-way parity guard, same convention as analytics-events-contract.test.ts:
 * LEGAL_DOCS_VERSION is mirrored across server (canonical — it stamps the
 * consent ledger), web, and mobile, which share no code. Before this guard
 * existed the three copies drifted silently. process.cwd() is correct here —
 * this is a web-side test and only runs from the repo root suite.
 */
describe("LEGAL_DOCS_VERSION parity (server ⇄ web ⇄ mobile)", () => {
  const repoRoot = process.cwd();
  const readVersion = (relPath: string): string => {
    const src = readFileSync(resolve(repoRoot, relPath), "utf8");
    const m = src.match(/LEGAL_DOCS_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (!m) throw new Error(`LEGAL_DOCS_VERSION not found in ${relPath}`);
    return m[1];
  };

  it("web mirror matches the server canonical", () => {
    expect(LEGAL_DOCS_VERSION).toBe(readVersion("server/src/modules/users/legal-docs-version.ts"));
  });

  it("mobile mirror matches the server canonical", () => {
    expect(readVersion("mobile/src/design/screens/LegalScreens.tsx")).toBe(
      readVersion("server/src/modules/users/legal-docs-version.ts"),
    );
  });
});
