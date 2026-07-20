/**
 * usePushNotifications
 *
 * Two entry points, kept separate so the prompt-when-asked and
 * refresh-quietly-on-sign-in flows can't accidentally merge:
 *
 *   - `enable()` triggers the browser permission dialog. Only call this
 *     from an explicit user action (click on a CTA). Returns the resulting
 *     permission state so the caller can show appropriate UX.
 *   - `enableIfAlreadyGranted()` does NOT prompt — it only registers/refreshes
 *     the FCM token when the user previously granted permission. Safe to
 *     call on every sign-in.
 *
 * `permissionState()` returns a snapshot (`"granted" | "denied" | "default" |
 * "unsupported"`) the UI uses to decide whether to render the enable CTA,
 * a denied note, or nothing.
 */
import { useCallback, useRef } from "react";
import { getApps, initializeApp } from "firebase/app";
import { getMessaging, getToken, onMessage } from "firebase/messaging";
import { frontendConfig } from "@/config/frontend";
import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import { toast } from "sonner";

export type PushPermissionState = "granted" | "denied" | "default" | "unsupported";
export type EnableResult = PushPermissionState | "missing-config";

export function pushSupported(): boolean {
  return typeof window !== "undefined"
    && "Notification" in window
    && "serviceWorker" in navigator
    && !!frontendConfig.firebase.vapidKey
    && !!frontendConfig.firebase.appId;
}

export function permissionState(): PushPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as PushPermissionState;
}

const STORAGE_KEY = "fcm_token_registered";

function getFirebaseApp() {
  if (getApps().length > 0) return getApps()[0]!;
  const cfg: Record<string, string> = {
    apiKey: frontendConfig.firebase.apiKey!,
    authDomain: frontendConfig.firebase.authDomain!,
    projectId: frontendConfig.firebase.projectId!,
  };
  if (frontendConfig.firebase.appId) cfg.appId = frontendConfig.firebase.appId;
  if (frontendConfig.firebase.messagingSenderId) cfg.messagingSenderId = frontendConfig.firebase.messagingSenderId;
  if (frontendConfig.firebase.storageBucket) cfg.storageBucket = frontendConfig.firebase.storageBucket;
  return initializeApp(cfg);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    // Post Firebase config to the service worker so it can initialise FCM
    const sw = reg.installing ?? reg.waiting ?? reg.active;
    if (sw) {
      sw.postMessage({
        type: "FIREBASE_CONFIG",
        config: {
          apiKey: frontendConfig.firebase.apiKey,
          authDomain: frontendConfig.firebase.authDomain,
          projectId: frontendConfig.firebase.projectId,
          appId: frontendConfig.firebase.appId,
          messagingSenderId: frontendConfig.firebase.messagingSenderId,
          storageBucket: frontendConfig.firebase.storageBucket,
        },
      });
    }
    return reg;
  } catch {
    return null;
  }
}

export function usePushNotifications() {
  const enabling = useRef(false);

  /** Shared token registration. Assumes Notification.permission is
   *  already "granted" — caller is responsible for that check. Registers
   *  the service worker, fetches the FCM token, and POSTs it to the
   *  backend (skipped when unchanged from localStorage). Also wires the
   *  foreground onMessage handler so an open tab sees a toast. Idempotent
   *  thanks to the `enabling` ref + the STORAGE_KEY short-circuit. */
  const registerToken = useCallback(async (): Promise<EnableResult> => {
    if (enabling.current) return permissionState();
    if (!pushSupported()) {
      return frontendConfig.firebase.vapidKey && frontendConfig.firebase.appId
        ? "unsupported"
        : "missing-config";
    }
    enabling.current = true;
    try {
      const swReg = await registerServiceWorker();
      if (!swReg) return "unsupported";

      const app = getFirebaseApp();
      const messaging = getMessaging(app);
      const token = await getToken(messaging, {
        vapidKey: frontendConfig.firebase.vapidKey,
        serviceWorkerRegistration: swReg,
      });
      if (!token) return "denied";

      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== token) {
        await apiRequest("/api/notifications/fcm-token", {
          method: "POST",
          headers: getJsonHeaders(),
          body: JSON.stringify({ token, platform: "web" }),
        });
        localStorage.setItem(STORAGE_KEY, token);
      }

      // Foreground messages — toast so the user notices when the tab is
      // already in front (the SW only surfaces the system notification
      // when the page is hidden / closed).
      onMessage(messaging, (payload) => {
        const title = payload.notification?.title ?? "IstaSeva";
        const body = payload.notification?.body ?? "";
        const link = payload.data?.link;
        toast(title, {
          description: body,
          action: link ? { label: "View", onClick: () => window.location.assign(link) } : undefined,
          duration: 6000,
        });
      });
      return "granted";
    } catch {
      // Silent — push is enhancement, not core functionality
      return permissionState();
    } finally {
      enabling.current = false;
    }
  }, []);

  /** User-initiated: prompts the browser permission dialog then registers
   *  the token. Returns a state the UI can use to show the right next
   *  step (toast on denied, success state on granted). NEVER call this
   *  from page-load effects — only from a click. */
  const enable = useCallback(async (): Promise<EnableResult> => {
    if (!pushSupported()) {
      return frontendConfig.firebase.vapidKey && frontendConfig.firebase.appId
        ? "unsupported"
        : "missing-config";
    }
    const current = permissionState();
    if (current === "granted") return registerToken();
    if (current === "denied") return "denied";

    const permission = await Notification.requestPermission();
    if (permission !== "granted") return permission as PushPermissionState;
    return registerToken();
  }, [registerToken]);

  /** Sign-in path: refreshes the FCM token only when the user previously
   *  granted permission. Never prompts. Safe to fire-and-forget on every
   *  auth state change. */
  const enableIfAlreadyGranted = useCallback(async (): Promise<EnableResult> => {
    if (!pushSupported()) return "unsupported";
    if (permissionState() !== "granted") return permissionState();
    return registerToken();
  }, [registerToken]);

  const disable = useCallback(async (token: string) => {
    try {
      await apiRequest("/api/notifications/fcm-token", {
        method: "DELETE",
        headers: getJsonHeaders(),
        body: JSON.stringify({ token }),
      });
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return { enable, enableIfAlreadyGranted, disable };
}
