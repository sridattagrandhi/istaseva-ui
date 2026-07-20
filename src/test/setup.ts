import "@testing-library/jest-dom";

// Root Vitest runs both frontend and backend tests. A few backend modules
// validate env at import time, so seed a safe local baseline here unless a
// specific test overrides it.
if (typeof process !== "undefined") {
  process.env.NODE_ENV ||= "test";
  process.env.APP_ENV ||= "test";
  process.env.JWT_SECRET ||= "test-secret";
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
