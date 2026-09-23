import { useState } from "react";
import { Camera, Check, ImagePlus, Scale } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { toCompressedBase64 } from "@/lib/image";
import { Input } from "@/components/ui/input";
import FilePickButton from "@/components/FilePickButton";
import { useAuth } from "@/contexts/AuthContext";

const UNIT_NUMBERS = [1, 2, 3] as const;

export default function MenuUnitWastage({
  plan, item, canteenId, onSaved,
}: { plan: any; item: any; canteenId: string; onSaved: () => void }) {
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [busyUnit, setBusyUnit] = useState<number | null>(null);
  const { isManagerOrAbove, isOwner } = useAuth();
  const entries: any[] = item.menu_unit_wastage || [];

  const save = async (unitNo: number, file: File) => {
    const existing = entries.find((row) => Number(row.unit_no) === unitNo);
    const quantity = Number(quantities[unitNo]);
    if (!(quantity > 0)) {
      toast.error(`Unit ${unitNo} ka wastage weight pehle bharein`);
      return;
    }
    if (!file.type.startsWith("image/")) {
      toast.error("Wastage ki photo select karein");
      return;
    }
    if (existing && !isManagerOrAbove) {
      toast.error("Saved wastage sirf Manager correct kar sakta hai");
      return;
    }
    if (existing && !reasons[unitNo]?.trim()) {
      toast.error("Wastage correction ka reason likhna zaroori hai");
      return;
    }

    setBusyUnit(unitNo);
    try {
      const { base64, mimeType } = await toCompressedBase64(file);
      const ext = (mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const path = `${canteenId}/${plan.id}/${item.id}/unit-${unitNo}-${Date.now()}.${ext}`;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const upload = await supabase.storage.from("wastage").upload(path, bytes, {
        contentType: mimeType,
      });
      if (upload.error) throw upload.error;

      const { error } = await supabase.rpc("record_menu_item_unit_wastage" as any, {
        p_menu_plan_item_id: item.id,
        p_unit_no: unitNo,
        p_quantity: quantity,
        p_photo_path: path,
        p_reason: existing ? reasons[unitNo].trim() : null,
      });
      if (error) throw error;

      toast.success(existing
        ? `${item.dish_name} · Unit ${unitNo} wastage correct ho gaya`
        : `${item.dish_name} · Unit ${unitNo}: ${quantity} kg wastage save ho gaya`);
      setQuantities((old) => ({ ...old, [unitNo]: "" }));
      setReasons((old) => ({ ...old, [unitNo]: "" }));
      onSaved();
    } catch (error: any) {
      toast.error(error.message || `Unit ${unitNo} ka wastage save nahi hua`);
    } finally {
      setBusyUnit(null);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
      <div>
        <p className="text-xs font-semibold">{item.dish_name} — Unit 1/2/3 wastage</p>
        <p className="text-[11px] text-muted-foreground">Is item ka har unit ka weight aur photo alag save hoga.</p>
      </div>

      {UNIT_NUMBERS.map((unitNo) => {
        const done = entries.find((row) => Number(row.unit_no) === unitNo);
        if (done) {
          return (
            <div key={unitNo} className="rounded-md border bg-card p-2 text-xs space-y-2">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-success shrink-0" />
                <b>Unit {unitNo}</b>
                <span className="text-success">{Number(done.quantity)} kg · photo saved</span>
                {done.corrected_at && <span className="text-muted-foreground">· corrected</span>}
              </div>
              {isManagerOrAbove && (
                <div className="space-y-2 border-t pt-2">
                  <p className="font-semibold">Galat entry correct karein</p>
                  <Input
                    type="number" min={0} step="any" inputMode="decimal"
                    placeholder="Correct wastage kg"
                    className="h-9 text-xs"
                    value={quantities[unitNo] || ""}
                    onChange={(event) => setQuantities((old) => ({ ...old, [unitNo]: event.target.value }))}
                  />
                  <Input
                    placeholder="Correction reason (mandatory)"
                    className="h-9 text-xs"
                    value={reasons[unitNo] || ""}
                    onChange={(event) => setReasons((old) => ({ ...old, [unitNo]: event.target.value }))}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <FilePickButton onPick={(file) => save(unitNo, file)} accept="image/*" capture
                      disabled={busyUnit !== null} className="h-9 px-2 border bg-secondary text-secondary-foreground text-xs">
                      <Camera className="w-3.5 h-3.5" /> {busyUnit === unitNo ? "Saving…" : "New camera photo"}
                    </FilePickButton>
                    <FilePickButton onPick={(file) => save(unitNo, file)} accept="image/*"
                      disabled={busyUnit !== null} className="h-9 px-2 border bg-secondary text-secondary-foreground text-xs">
                      <ImagePlus className="w-3.5 h-3.5" /> New photo upload
                    </FilePickButton>
                  </div>
                </div>
              )}
            </div>
          );
        }

        if (isManagerOrAbove && !isOwner) {
          return (
            <div key={unitNo} className="rounded-md border bg-card p-2 text-xs text-muted-foreground">
              <b className="text-foreground">Unit {unitNo}</b> · HS wastage entry pending
            </div>
          );
        }

        return (
          <div key={unitNo} className="rounded-md border bg-card p-2 space-y-2">
            <div className="flex items-center gap-2">
              <b className="text-xs w-12 shrink-0">Unit {unitNo}</b>
              <div className="relative flex-1 min-w-0">
                <Scale className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="number" min={0} step="any" inputMode="decimal"
                  placeholder="wastage kg"
                  className="h-9 text-xs pl-7"
                  value={quantities[unitNo] || ""}
                  onChange={(event) => setQuantities((old) => ({ ...old, [unitNo]: event.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <FilePickButton
                onPick={(file) => save(unitNo, file)}
                accept="image/*"
                capture
                disabled={busyUnit !== null}
                className="h-9 px-2 border bg-secondary text-secondary-foreground text-xs"
              >
                <Camera className="w-3.5 h-3.5" /> {busyUnit === unitNo ? "Saving…" : "Camera"}
              </FilePickButton>
              <FilePickButton
                onPick={(file) => save(unitNo, file)}
                accept="image/*"
                disabled={busyUnit !== null}
                className="h-9 px-2 border bg-secondary text-secondary-foreground text-xs"
              >
                <ImagePlus className="w-3.5 h-3.5" /> Photo upload
              </FilePickButton>
            </div>
          </div>
        );
      })}
    </div>
  );
}
