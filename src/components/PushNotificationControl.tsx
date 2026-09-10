import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { disablePush, enablePush, pushSupportMessage, syncExistingPush, testPush } from "@/lib/pushNotifications";

export default function PushNotificationControl() {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const unsupported = pushSupportMessage();
  useEffect(() => {
    let alive = true;
    setEnabled(false);
    if (user?.id) syncExistingPush().then((value) => {
      if (alive) setEnabled(value);
    }).catch(() => {
      if (alive) setMessage("Phone alerts sync nahi hue. Dobara chalu karein.");
    });
    return () => { alive = false; };
  }, [user?.id]);

  async function action(task: () => Promise<unknown>, success: string, next?: boolean) {
    setBusy(true); setMessage("");
    try {
      await task();
      if (next !== undefined) setEnabled(next);
      setMessage(success);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Dobara try karein."); }
    finally { setBusy(false); }
  }

  return (
    <div className="border-b p-3 space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium"><BellRing className="h-4 w-4" /> Phone sound alerts</p>
      <p className="text-xs text-muted-foreground">
        {unsupported || (enabled
          ? "Is phone par alerts chalu hain. Sound phone ki notification settings par depend hai."
          : "Order, approval aur issue ke alerts app band / screen locked hone par bhi paayein.")}
      </p>
      {!unsupported && <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => enabled
          ? action(disablePush, "Is phone par alerts band.", false)
          : action(enablePush, "Alerts chalu. Test alert bhejkar sound check karein.", true)}>
          {busy ? "Please wait…" : enabled ? "Alerts band karo" : "Notifications chalu karo"}
        </Button>
        {enabled && <Button variant="outline" size="sm" disabled={busy}
          onClick={() => action(testPush, "Test bheja. Notification aaye toh sound check karein.")}>
          Test alert
        </Button>}
      </div>}
      {message && <p role="status" className="text-xs break-words">{message}</p>}
      <p className="text-[11px] text-muted-foreground">Phone off, internet off, silent/DND ya force-stop mein turant sound nahi aa sakta.</p>
    </div>
  );
}
