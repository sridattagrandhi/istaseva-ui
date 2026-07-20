import { describe, it, expect } from "vitest";
import { detectTtsLang } from "./useVoiceAssistant";

describe("detectTtsLang", () => {
  it("detects Telugu script regardless of the app fallback", () => {
    expect(detectTtsLang("మీకు ఏ సేవ కావాలి?", "en-IN")).toBe("te-IN");
  });

  it("detects Tamil, Kannada, Malayalam, Bengali, Gujarati", () => {
    expect(detectTtsLang("உங்களுக்கு என்ன வேண்டும்?", "en-IN")).toBe("ta-IN");
    expect(detectTtsLang("ನಿಮಗೆ ಏನು ಬೇಕು?", "en-IN")).toBe("kn-IN");
    expect(detectTtsLang("നിങ്ങൾക്ക് എന്ത് വേണം?", "en-IN")).toBe("ml-IN");
    expect(detectTtsLang("আপনি কী চান?", "en-IN")).toBe("bn-IN");
    expect(detectTtsLang("તમને શું જોઈએ છે?", "en-IN")).toBe("gu-IN");
  });

  it("maps Devanagari to Hindi by default", () => {
    expect(detectTtsLang("आपको क्या चाहिए?", "en-IN")).toBe("hi-IN");
  });

  it("keeps Marathi for Devanagari when the session output language is Marathi", () => {
    expect(detectTtsLang("तुम्हाला काय हवे आहे?", "mr-IN")).toBe("mr-IN");
  });

  it("falls back to the session output language for Latin/English text", () => {
    expect(detectTtsLang("Truefitt & Hill does women's haircuts for Rs 1200.", "en-IN")).toBe("en-IN");
  });

  it("falls back to en-IN when there is no fallback and no Indian script", () => {
    expect(detectTtsLang("Hello there", "")).toBe("en-IN");
  });

  it("picks the dominant script in mixed text", () => {
    // Mostly Telugu with an English brand name + price embedded.
    expect(detectTtsLang("Truefitt & Hill లో మహిళల హెయిర్‌కట్ ₹1200 ఖర్చు అవుతుంది.", "en-IN")).toBe("te-IN");
  });
});
