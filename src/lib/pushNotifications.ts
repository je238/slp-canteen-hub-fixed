import { supabase } from "@/integrations/supabase/client";

const rpc = supabase as any;
const PUSH_API = import.meta.env.VITE_SUPABASE_URL + "/functions/v1/web-push";

export function pushSupportMessage(): string | null {
  if (!window.isSecureContext) return "Notifications ke liye HTTPS zaroori hai.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "Chrome mein app khol kar notifications chalu karein. iPhone par Safari → Add to Home Screen. APK mein native push setup abhi baaki hai.";
  }
  return null;
}

export function decodePushKey(key: string): Uint8Array<ArrayBuffer> {
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - key.length % 4) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function persistSubscription(subscription: PushSubscription) {
  const data = subscription.toJSON();
  const { error } = await rpc.rpc("save_web_push_subscription", {
    p_endpoint: data.endpoint, p_p256dh: data.keys?.p256dh, p_auth: data.keys?.auth,
  });
  if (error) throw new Error(error.message);
}

export async function enablePush() {
  const unsupported = pushSupportMessage();
  if (unsupported) throw new Error(unsupported);
  // Request permission immediately from the tap (before any network await).
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications allow nahi hui. Browser/site settings mein Allow karein.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let publicKey: string;
  try {
    const response = await fetch(PUSH_API, { signal: controller.signal });
    if (!response.ok) throw new Error("Notification service abhi nahi mili. Dobara try karein.");
    ({ publicKey } = await response.json());
  } finally { clearTimeout(timeout); }
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true, applicationServerKey: decodePushKey(publicKey),
  });
  // Do not show 'enabled' unless the server really saved this device.
  await persistSubscription(subscription);
}

export async function syncExistingPush(): Promise<boolean> {
  if (pushSupportMessage() || Notification.permission !== "granted") return false;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  await persistSubscription(subscription);
  return true;
}

export async function disablePush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) return;
  try {
    const { error } = await rpc.rpc("remove_web_push_subscription", { p_endpoint: subscription.endpoint });
    if (error) throw new Error(error.message);
  } finally {
    // Even a thrown network error must not leave the signed-out user's device active.
    await subscription.unsubscribe();
  }
}

export async function testPush() {
  const { error } = await rpc.rpc("test_my_web_push");
  if (error) throw new Error(error.message);
}
