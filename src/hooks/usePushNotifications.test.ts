// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock apiRequest so we can assert the URL + headers the hook sends — this
// is the bug we fixed (previous path was "/notifications/fcm-token" which
// 404'd since the backend mounts at /api/notifications).
const { apiRequest } = vi.hoisted(() => ({
  apiRequest: vi.fn(async () => ({ success: true, data: undefined })),
}));
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiRequest };
});

// Firebase isn't exercised by disable(); stub the modules so any incidental
// import side-effects don't try to reach the network in the test runner.
vi.mock("firebase/app", () => ({ getApps: () => [], initializeApp: vi.fn() }));
vi.mock("firebase/messaging", () => ({ getMessaging: vi.fn(), getToken: vi.fn(), onMessage: vi.fn() }));

import { usePushNotifications } from "./usePushNotifications";

describe("usePushNotifications", () => {
  beforeEach(() => {
    apiRequest.mockClear();
    localStorage.clear();
  });

  it("disables: DELETEs the FCM token at /api/notifications/fcm-token with JSON headers", async () => {
    const { result } = renderHook(() => usePushNotifications());

    await act(async () => {
      await result.current.disable("test-token");
    });

    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [path, init] = apiRequest.mock.calls[0];
    expect(path).toBe("/api/notifications/fcm-token");
    expect(init?.method).toBe("DELETE");
    // Content-Type must be set on the request — backend expects JSON.
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ token: "test-token" }));
  });
});
