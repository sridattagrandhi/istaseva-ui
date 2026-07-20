import { describe, expect, it } from "vitest";
import { downloadBookingInvoice } from "./invoice";

describe("legacy frontend invoice generator", () => {
  it("is deprecated and throws on use, forcing callers to the backend PDF endpoint", () => {
    expect(() => downloadBookingInvoice({} as any)).toThrow(/deprecated/i);
    expect(() => downloadBookingInvoice({} as any)).toThrow(/booking-invoice/);
  });
});
