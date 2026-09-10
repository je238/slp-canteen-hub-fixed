import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Camera, Check, Scale } from "lucide-react";
import { toast } from "sonner";
import { toCompressedBase64 } from "@/lib/image";

// Wastage, weighed and photographed, by the manager.
//
// It used to be the chef's own box. That is the one number in the kitchen the
// chef should not be the sole author of: food that left the pot and never
// reached a plate looks exactly like food that was cooked, and exactly like
// food that walked out. The only difference is what somebody types.
//
// So it moves here, and it comes with a picture of the tray on the scale.
// Not because anyone is assumed dishonest — because a number nobody can check
// is no use to the person it is meant to protect, and a photograph settles in
// a second what an argument never will.

export default function WastageEntry({
  item, canteenId, onSaved,
}: { item: any; canteenId: string; onSaved: () => void }) {
  const [qty, setQty] = useState(item.wastage_qty != null ? String(item.wastage_qty) : "");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const alreadyDone = item.wastage_qty != null && item.wastage_photo_url;

  const save = async (file: File) => {
    const n = Number(qty);
    if (!(n > 0)) { toast.error("Enter the weight first, then take the photo"); return; }
    setBusy(true);
    try {
      const { base64, mimeType } = await toCompressedBase64(file);
      const ext = (mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const path = `${canteenId}/${Date.now()}-${item.id}.${ext}`;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const up = await supabase.storage.from("wastage").upload(path, bytes, { contentType: mimeType });
      if (up.error) throw up.error;

      const { data, error } = await supabase
        .from("menu_plan_items")
        .update({ wastage_qty: n, wastage_photo_url: path })
        .eq("id", item.id)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("You are not allowed to record wastage on this meal");

      toast.success(`${n} ${item.unit || "kg"} of ${item.dish_name} recorded, with the photo`);
      onSaved();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  if (alreadyDone) {
    return (
      <p className="text-[11px] text-success flex items-center gap-1 mt-1">
        <Check className="w-3 h-3" />
        wastage {Number(item.wastage_qty)} {item.unit || "kg"} · photo on file
      </p>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
      <div className="relative">
        <Scale className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="number" min={0} placeholder="wastage"
          className="h-7 text-xs w-28 pl-7"
          value={qty} onChange={(e) => setQty(e.target.value)}
        />
      </div>
      {/* The camera opens straight to the back lens on a phone, so the tray on
          the scale is one tap away rather than a trip through the gallery. */}
      <input
        ref={fileRef} type="file" accept="image/*" capture="environment"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) save(f); e.target.value = ""; }}
      />
      <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1"
        disabled={busy} onClick={() => fileRef.current?.click()}>
        <Camera className="w-3 h-3" /> {busy ? "saving…" : "weigh & photo"}
      </Button>
    </div>
  );
}
