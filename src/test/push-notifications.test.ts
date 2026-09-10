import { beforeEach, describe, expect, it, vi } from "vitest";
import { enablePush, disablePush, syncExistingPush, decodePushKey, pushSupportMessage } from "@/lib/pushNotifications";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));

const subscription = {
  endpoint: "https://fcm.googleapis.com/test",
  toJSON: () => ({ endpoint: "https://fcm.googleapis.com/test", keys: { p256dh: "key", auth: "auth" } }),
  unsubscribe: vi.fn(async () => true),
};
const manager = { getSubscription: vi.fn(), subscribe: vi.fn() };
const registration = { pushManager: manager };
const permission = vi.fn();
beforeEach(() => {
  vi.restoreAllMocks(); rpc.mockReset(); rpc.mockResolvedValue({ error: null });
  manager.getSubscription.mockResolvedValue(null);
  manager.subscribe.mockResolvedValue(subscription);
  subscription.unsubscribe.mockClear();
  permission.mockResolvedValue("granted");
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", function () {});
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: permission });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
    register: vi.fn(async () => registration),
    ready: Promise.resolve(registration),
    getRegistration: vi.fn(async () => registration),
  }});
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ publicKey: "AQID" }) })));
});

describe("phone push enrollment", () => {
  it("decodes a base64url VAPID key", () => expect([...decodePushKey("AQID")]).toEqual([1,2,3]));
  it("asks permission from a user action then persists subscription", async () => {
    await enablePush();
    expect(permission).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("save_web_push_subscription", {
      p_endpoint: subscription.endpoint, p_p256dh: "key", p_auth: "auth",
    });
  });
  it("does not register a denied device", async () => {
    permission.mockResolvedValue("denied");
    await expect(enablePush()).rejects.toThrow("allow nahi");
    expect(rpc).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not claim success after a server failure", async () => {
    rpc.mockResolvedValue({ error: { message: "offline" } });
    await expect(enablePush()).rejects.toThrow("offline");
  });
  it("does not prompt for permission automatically", async () => {
    expect(await syncExistingPush()).toBe(false);
    expect(permission).not.toHaveBeenCalled();
  });
  it("refreshes only an already-authorized existing subscription", async () => {
    manager.getSubscription.mockResolvedValue(subscription);
    expect(await syncExistingPush()).toBe(true);
    expect(permission).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("unsubscribes the device even when server removal fails", async () => {
    manager.getSubscription.mockResolvedValue(subscription);
    rpc.mockResolvedValue({ error: { message: "offline" } });
    await expect(disablePush()).rejects.toThrow("offline");
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });
  it("explains unsupported platforms rather than promising delivery", () => {
    vi.stubGlobal("isSecureContext", false);
    expect(pushSupportMessage()).toContain("HTTPS");
  });
  it("revokes the browser subscription when the network call throws", async () => {
    manager.getSubscription.mockResolvedValue(subscription);
    rpc.mockRejectedValue(new Error("network disconnected"));
    await expect(disablePush()).rejects.toThrow("network disconnected");
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
  });
});
