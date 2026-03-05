import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type TableName = "orders" | "ingredients" | "purchases" | "expenses";

const tableToQueryKeys: Record<TableName, string[]> = {
  orders: ["orders"],
  ingredients: ["ingredients"],
  purchases: ["purchases"],
  expenses: ["expenses"],
};

export function useRealtimeSubscription(tables: TableName[]) {
  const qc = useQueryClient();
  // Use a ref to avoid stale closure — always points to latest qc
  const qcRef = useRef(qc);
  useEffect(() => { qcRef.current = qc; }, [qc]);

  // Stable key from sorted table names to avoid unnecessary re-subscriptions
  const tablesKey = [...tables].sort().join(",");

  useEffect(() => {
    // Unique channel name to avoid collisions across multiple subscribers
    const channelName = `realtime-${tablesKey}-${Math.random().toString(36).slice(2)}`;
    const channel = supabase.channel(channelName);

    for (const table of tables) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => {
          for (const key of tableToQueryKeys[table]) {
            qcRef.current.invalidateQueries({ queryKey: [key] });
          }
        }
      );
    }

    channel.subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablesKey]);
}
