import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker() {
  const handlers: Record<string, (event: any) => void> = {};
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  const postMessage = vi.fn();
  const scope = {
    location: { origin: "https://slp.example" },
    addEventListener: (name: string, cb: any) => { handlers[name] = cb; },
    registration: { showNotification },
    clients: { matchAll: vi.fn(async () => [{ postMessage }]), openWindow },
  };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self: scope, URL });
  return { handlers, showNotification, openWindow, scope, postMessage };
}
describe("background push worker", () => {
  it("shows a visible non-silent notification and refreshes the bell", async () => {
    const w = worker(); let completion: Promise<void>;
    w.handlers.push({ data: { json: () => ({ id: "n1", title: "Approved", body: "Issue stock", url: "/requisitions" }) },
      waitUntil: (p: Promise<void>) => { completion = p; } });
    await completion!;
    expect(w.showNotification).toHaveBeenCalledWith("Approved", expect.objectContaining({
      silent: false, tag: "slp-n1", data: { url: "/requisitions" },
    }));
    expect(w.postMessage).toHaveBeenCalledWith({ type: "SLP_NOTIFICATION_RECEIVED" });
  });
  it("uses a safe fallback for malformed payloads", async () => {
    const w = worker(); let completion: Promise<void>;
    w.handlers.push({ data: { json: () => { throw Error("bad JSON"); } },
      waitUntil: (p: Promise<void>) => { completion = p; } });
    await completion!;
    expect(w.showNotification).toHaveBeenCalledWith("SLP Canteen Hub", expect.anything());
  });
  it("does not allow a notification to navigate outside the app", async () => {
    const w = worker(); let completion: Promise<void>;
    w.scope.clients.matchAll.mockResolvedValue([]);
    w.handlers.notificationclick({ notification: { close: vi.fn(), data: { url: "https://evil.example" } },
      waitUntil: (p: Promise<void>) => { completion = p; } });
    await completion!;
    expect(w.openWindow).toHaveBeenCalledWith("https://slp.example/dashboard");
  });
});
