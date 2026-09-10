import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAppContext } from "@/contexts/AppContext";
import { useNotifications, useMarkNotificationRead } from "@/hooks/useSrsData";
import { Bell, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import PushNotificationControl from "@/components/PushNotificationControl";

// Admins watch the whole requisition chain from here; everyone else sees
// what was addressed to them. The dot only appears when something is
// genuinely unread — it used to be painted on permanently.

function ago(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function NotificationBell() {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onPush = (event: MessageEvent) => {
      if (event.data?.type === "SLP_NOTIFICATION_RECEIVED") {
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
      }
    };
    navigator.serviceWorker.addEventListener("message", onPush);
    return () => navigator.serviceWorker.removeEventListener("message", onPush);
  }, [queryClient]);
  const { selectedCanteen } = useAppContext();
  const { data: items } = useNotifications(selectedCanteen);
  const markRead = useMarkNotificationRead();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const list = items || [];
  const unread = list.filter((n: any) => !n.read_at);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="relative p-2 rounded-md hover:bg-secondary" aria-label="Notifications">
          <Bell className="w-4 h-4 text-muted-foreground" />
          {unread.length > 0 && (
            <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center">
              {unread.length > 9 ? "9+" : unread.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-0">
        <PushNotificationControl />
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <p className="text-sm font-semibold">Notifications</p>
          {unread.length > 0 && (
            <Button
              variant="ghost" size="sm" className="h-7 text-xs"
              onClick={() => unread.forEach((n: any) => markRead.mutate(n.id))}
            >
              <Check className="w-3.5 h-3.5 mr-1" /> Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {list.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
          ) : list.slice(0, 25).map((n: any) => (
            <button
              key={n.id}
              className={`w-full text-left px-3 py-2 border-b last:border-0 hover:bg-secondary/60 ${
                n.read_at ? "opacity-60" : ""
              }`}
              onClick={() => {
                if (!n.read_at) markRead.mutate(n.id);
                setOpen(false);
                if (n.link) navigate(n.link);
              }}
            >
              <div className="flex items-start gap-2">
                {!n.read_at && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{n.title}</p>
                  {n.body && <p className="text-xs text-muted-foreground line-clamp-2">{n.body}</p>}
                  <p className="text-[11px] text-muted-foreground mt-0.5">{ago(n.created_at)}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
