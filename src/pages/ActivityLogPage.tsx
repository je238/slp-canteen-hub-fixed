import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Activity, Search, Filter } from "lucide-react";

const ACTION_COLORS: Record<string, string> = {
  create: "bg-green-500/10 text-green-600 border-green-500/20",
  update: "bg-blue-500/10 text-blue-600 border-blue-500/20",
  delete: "bg-red-500/10 text-red-600 border-red-500/20",
  confirm: "bg-purple-500/10 text-purple-600 border-purple-500/20",
  login: "bg-accent/10 text-accent border-accent/20",
};

const ACTION_ICONS: Record<string, string> = {
  create: "➕",
  update: "✏️",
  delete: "🗑️",
  confirm: "✅",
  login: "🔑",
};

export default function ActivityLogPage() {
  const { selectedCanteen } = useAppContext();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("all");

  const { data: logs, isLoading } = useQuery({
    queryKey: ["action_logs", selectedCanteen],
    queryFn: async () => {
      let q = supabase
        .from("action_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (selectedCanteen && selectedCanteen !== "all") {
        q = q.eq("canteen_id", selectedCanteen);
      }
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });

  const filtered = logs?.filter((log: any) => {
    const matchSearch = search === "" ||
      log.action?.toLowerCase().includes(search.toLowerCase()) ||
      log.entity_type?.toLowerCase().includes(search.toLowerCase());
    const matchType = filterType === "all" || getActionType(log.action) === filterType;
    return matchSearch && matchType;
  });

  const getActionType = (action: string) => {
    if (action?.toLowerCase().includes("create") || action?.toLowerCase().includes("add")) return "create";
    if (action?.toLowerCase().includes("update") || action?.toLowerCase().includes("edit")) return "update";
    if (action?.toLowerCase().includes("delete") || action?.toLowerCase().includes("remove")) return "delete";
    if (action?.toLowerCase().includes("confirm") || action?.toLowerCase().includes("approve")) return "confirm";
    return "update";
  };

  const formatTime = (ts: string) => {
    const date = new Date(ts);
    const now = new Date();
    const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (diff < 60) return "Just now";
    if (diff < 3600) return Math.floor(diff / 60) + " min ago";
    if (diff < 86400) return Math.floor(diff / 3600) + " hrs ago";
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <AppLayout title="Activity Log">
      <div className="space-y-4 animate-fade-in">
        <p className="text-sm text-muted-foreground">See everything that happened - who did what and when</p>
        <div className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search activity..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="create">Created</SelectItem>
              <SelectItem value="update">Updated</SelectItem>
              <SelectItem value="delete">Deleted</SelectItem>
              <SelectItem value="confirm">Confirmed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4" /> Recent Activity ({filtered?.length || 0})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground text-center py-6">Loading...</p>
            ) : !filtered?.length ? (
              <div className="text-center py-8 space-y-2">
                <p className="text-3xl">📋</p>
                <p className="text-sm text-muted-foreground">No activity recorded yet</p>
                <p className="text-xs text-muted-foreground">Actions like adding items and creating orders will appear here</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filtered.map((log: any) => {
                  const actionType = getActionType(log.action);
                  return (
                    <div key={log.id} className="flex items-start gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/40 transition-colors">
                      <div className="text-lg mt-0.5">{ACTION_ICONS[actionType]}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className={"text-[10px] capitalize " + ACTION_COLORS[actionType]}>{actionType}</Badge>
                          {log.entity_type && <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground">{log.entity_type}</Badge>}
                        </div>
                        <p className="text-sm font-medium mt-0.5">{log.action}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          👤 {log.user_id ? "User " + log.user_id.slice(0, 8) + "..." : "System"} • {formatTime(log.created_at)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
