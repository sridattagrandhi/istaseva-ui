import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVENT_NAMES as WEB_NAMES } from "./analytics-events-contract";

/**
 * PUX-014 drift guard. The analytics event taxonomy is mirrored across three
 * codebases that share no code (server canonical, web mirror, mobile mirror).
 * These extract the event-name set from each file by parsing and assert all
 * three agree — so a name added to one place but not the others fails CI.
 */

const repoRoot = process.cwd();

function readNamesFromArray(relPath: string): string[] {
  const src = readFileSync(resolve(repoRoot, relPath), "utf8");
  const start = src.indexOf("EVENT_NAMES = [");
  const end = src.indexOf("] as const", start);
  const block = src.slice(start, end);
  // Comment lines carry no quotes, so matching quoted snake_case is safe here.
  return [...block.matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((m) => m[1]);
}

function readServerRegistryNames(): string[] {
  const src = readFileSync(
    resolve(repoRoot, "server/src/modules/analytics/contract/events.ts"),
    "utf8",
  );
  const start = src.indexOf("ANALYTICS_EVENTS = {");
  const end = src.indexOf("} as const satisfies", start);
  const block = src.slice(start, end);
  // Registry entries look like `  login: { version: 1, ... },`.
  return [...block.matchAll(/^\s{2}([a-z][a-z0-9_]*): \{ version:/gm)].map((m) => m[1]);
}

describe("analytics event contract (PUX-014)", () => {
  const serverNames = readServerRegistryNames();
  const mobileNames = readNamesFromArray("mobile/src/design/api/analyticsEventsContract.ts");

  it("the server registry is non-empty and parsed correctly", () => {
    expect(serverNames.length).toBeGreaterThan(10);
    expect(serverNames).toContain("booking_confirmed");
  });

  it("has no duplicate names in any file", () => {
    for (const [label, names] of [
      ["web", [...WEB_NAMES]],
      ["mobile", mobileNames],
      ["server", serverNames],
    ] as const) {
      expect(new Set(names).size, `${label} has duplicates`).toBe(names.length);
    }
  });

  it("web, mobile, and server expose the identical event-name set", () => {
    const web = [...WEB_NAMES].sort();
    const mobile = [...mobileNames].sort();
    const server = [...serverNames].sort();
    expect(mobile).toEqual(web);
    expect(server).toEqual(web);
  });

  it("every booking-funnel stage is a known event", () => {
    const src = readFileSync(
      resolve(repoRoot, "server/src/modules/analytics/contract/events.ts"),
      "utf8",
    );
    const start = src.indexOf("BOOKING_FUNNEL");
    const block = src.slice(start, src.indexOf("];", start));
    const stages = [...block.matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((m) => m[1]);
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) expect(serverNames).toContain(stage);
  });
});
