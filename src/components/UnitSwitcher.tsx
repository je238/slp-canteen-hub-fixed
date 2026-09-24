import { useEffect, useMemo } from "react";
import { Building2 } from "lucide-react";
import { useAppContext } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useCanteens } from "@/hooks/useSupabaseData";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type UnitSwitcherProps = {
  variant?: "header" | "sidebar";
};

export default function UnitSwitcher({ variant = "header" }: UnitSwitcherProps) {
  const { selectedCanteen, setSelectedCanteen } = useAppContext();
  const { rank, roleData, canAccessCanteen } = useAuth();
  const { data: canteens = [], isLoading } = useCanteens();

  const accessibleUnits = useMemo(() => {
    if (rank >= 60) return canteens as any[];
    return (canteens as any[]).filter((unit) => canAccessCanteen(unit.id));
  }, [canteens, rank, canAccessCanteen]);
  const canSeeAll = rank >= 50 && accessibleUnits.length > 1;
  const allLabel = accessibleUnits.length > 0
    ? `All ${accessibleUnits.length} Units`
    : "All Units";

  useEffect(() => {
    if (isLoading || accessibleUnits.length === 0) return;
    const primary = accessibleUnits.find((unit) => unit.id === roleData.canteen_id)?.id
      || accessibleUnits[0].id;
    if (selectedCanteen === "all" && !canSeeAll) {
      setSelectedCanteen(primary);
      return;
    }
    if (selectedCanteen !== "all" && !accessibleUnits.some((unit) => unit.id === selectedCanteen)) {
      setSelectedCanteen(canSeeAll ? "all" : primary);
    }
  }, [accessibleUnits, canSeeAll, isLoading, roleData.canteen_id, selectedCanteen, setSelectedCanteen]);

  if (isLoading || accessibleUnits.length === 0) return null;

  const sidebar = variant === "sidebar";
  return (
    <Select value={selectedCanteen} onValueChange={setSelectedCanteen}>
      <SelectTrigger
        aria-label="Unit select karein"
        className={sidebar
          ? "h-10 w-full border-sidebar-border bg-sidebar-accent text-xs text-sidebar-accent-foreground"
          : "h-9 w-[132px] gap-1 border-primary/20 bg-background px-2 text-xs sm:w-[190px]"}
      >
        <Building2 className="h-4 w-4 shrink-0" />
        <SelectValue placeholder="Unit select karein" />
      </SelectTrigger>
      <SelectContent>
        {canSeeAll ? <SelectItem value="all">{allLabel}</SelectItem> : null}
        {accessibleUnits.map((unit) => (
          <SelectItem key={unit.id} value={unit.id}>{unit.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
