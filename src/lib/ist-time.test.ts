import { describe, expect, it } from "vitest";
import {
  istDateIso, istNow, istToday, istTodayIso,
  istNowMinutes, slotTimeMinutes, isSlotTooSoon, BOOKING_LEAD_MINUTES,
} from "./ist-time";

/** minutes-since-midnight → "h:mm AM/PM" (the slot label shape the pickers use). */
const minToLabel = (m: number) => {
  const h = Math.floor(m / 60), mm = m % 60;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(mm).padStart(2, "0")} ${period}`;
};

describe("ist-time", () => {
  it("istTodayIso matches Intl's Asia/Kolkata calendar date", () => {
    // en-CA yields YYYY-MM-DD — the same shape the backend's past-date
    // gate builds with toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).
    const viaIntl = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    expect(istTodayIso()).toBe(viaIntl);
  });

  it("istNow reads IST wall-clock hours", () => {
    const viaIntl = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date()),
    ) % 24;
    // Allow the hour to tick over between the two reads.
    expect([viaIntl, (viaIntl + 1) % 24]).toContain(istNow().getHours());
  });

  it("istToday is istNow at midnight", () => {
    const t = istToday();
    expect([t.getHours(), t.getMinutes(), t.getSeconds()]).toEqual([0, 0, 0]);
    expect(istTodayIso().startsWith(String(t.getFullYear()))).toBe(true);
  });

  it("istDateIso offsets calendar days", () => {
    const today = istTodayIso();
    const tomorrow = istDateIso(1);
    expect(new Date(`${tomorrow}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()).toBe(86400000);
  });
});

describe("ist-time slot lead-time", () => {
  it("BOOKING_LEAD_MINUTES is 30", () => {
    expect(BOOKING_LEAD_MINUTES).toBe(30);
  });

  it("slotTimeMinutes parses 12-hour labels with/without a day prefix", () => {
    expect(slotTimeMinutes("9:00 AM")).toBe(540);
    expect(slotTimeMinutes("6:30 PM")).toBe(18 * 60 + 30);
    expect(slotTimeMinutes("12:00 AM")).toBe(0);
    expect(slotTimeMinutes("12:00 PM")).toBe(12 * 60);
    expect(slotTimeMinutes("Mon 7:15 AM")).toBe(7 * 60 + 15);
    expect(slotTimeMinutes("Today 6:30 PM")).toBe(18 * 60 + 30);
  });

  it("slotTimeMinutes returns null for unparseable labels", () => {
    expect(slotTimeMinutes("On request")).toBeNull();
    expect(slotTimeMinutes("")).toBeNull();
  });

  it("istNowMinutes agrees with istNow's wall-clock", () => {
    const now = istNow();
    expect([now.getHours() * 60 + now.getMinutes(), now.getHours() * 60 + now.getMinutes() + 1])
      .toContain(istNowMinutes());
  });

  it("never flags a future date as too soon", () => {
    const future = istDateIso(2);
    expect(isSlotTooSoon("6:00 AM", future)).toBe(false);
    expect(isSlotTooSoon("11:30 PM", future)).toBe(false);
  });

  it("flags a past slot today and clears one beyond the buffer", () => {
    const now = istNowMinutes();
    const today = istTodayIso();
    // Guards keep the constructed labels inside [0, 1439] so the assertions
    // don't flake near IST midnight.
    if (now - 5 >= 0) {
      expect(isSlotTooSoon(minToLabel(now - 5), today)).toBe(true);
    }
    if (now + BOOKING_LEAD_MINUTES + 10 <= 1439) {
      expect(isSlotTooSoon(minToLabel(now + BOOKING_LEAD_MINUTES + 10), today)).toBe(false);
    }
  });

  it("unparseable labels are never hidden", () => {
    expect(isSlotTooSoon("On request", istTodayIso())).toBe(false);
  });
});
