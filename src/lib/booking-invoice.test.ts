import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock api-client so the test never reaches network code paths. The
// contract we verify is "downloadBookingTaxInvoice routes to the backend
// PDF endpoint with the booking id, and uses an authenticated download".
vi.mock("./api-client", () => ({
  downloadAuthenticatedFile: vi.fn(async () => undefined),
}));

import { downloadAuthenticatedFile } from "./api-client";
import { downloadBookingTaxInvoice } from "./booking-invoice";

describe("downloadBookingTaxInvoice (backend PDF endpoint wiring)", () => {
  beforeEach(() => {
    (downloadAuthenticatedFile as any).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hits GET /api/bookings/:id/invoice.pdf via the authenticated downloader", async () => {
    await downloadBookingTaxInvoice("c4047da0-86d7-4df4-8ff6-ef0625f40dd6");
    expect(downloadAuthenticatedFile).toHaveBeenCalledTimes(1);
    expect(downloadAuthenticatedFile).toHaveBeenCalledWith(
      "/api/bookings/c4047da0-86d7-4df4-8ff6-ef0625f40dd6/invoice.pdf",
      // Filename carries the 16-char uppercase booking reference (mirrors
      // bookings.booking_reference / displayRef) — not the raw UUID prefix.
      expect.stringMatching(/^invoice-C4047DA086D74DF4\.pdf$/),
    );
  });

  it("URL-encodes the booking id so unusual characters are safe", async () => {
    await downloadBookingTaxInvoice("a/b c");
    expect(downloadAuthenticatedFile).toHaveBeenCalledWith(
      "/api/bookings/a%2Fb%20c/invoice.pdf",
      expect.any(String),
    );
  });

  it("rejects when no booking id is supplied", async () => {
    await expect(downloadBookingTaxInvoice("")).rejects.toThrow(/booking id/i);
    expect(downloadAuthenticatedFile).not.toHaveBeenCalled();
  });
});
