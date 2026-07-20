import { describe, it, expect } from "vitest";
import { formatLanguageList } from "./format-languages";

describe("formatLanguageList", () => {
  it("de-dupes the same language across casings and Title-Cases", () => {
    expect(formatLanguageList(["english", "hindi", "telugu", "English", "Hindi", "Telugu"]))
      .toBe("English, Hindi, Telugu");
  });

  it("preserves first-seen order and trims blanks", () => {
    expect(formatLanguageList(["  Tamil ", "tamil", "", "KANNADA"]))
      .toBe("Tamil, Kannada");
  });

  it("returns empty string for missing/empty input", () => {
    expect(formatLanguageList(undefined)).toBe("");
    expect(formatLanguageList(null)).toBe("");
    expect(formatLanguageList([])).toBe("");
  });
});
