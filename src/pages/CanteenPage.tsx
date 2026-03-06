import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useCanteens } from "@/hooks/useSupabaseData";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Building2, Plus, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

export default function CanteenPage() {
  const { data: canteens, isLoading } = useCanteens();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [staffCount, setStaffCount] = useState("");

  const addCanteen = useMutation({
    mutationFn: async () => {
      if (!name) throw new Error("Canteen name is required");
      const { error } = await supabase.from("canteens").insert({
        name,
        location: location || null,
        staff_count: staffCount ? Number(staffCount) : 0,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Canteen added!");
      qc.invalidateQueries({ queryKey: ["canteens"] });
      setDialogOpen(false);
      setName(""); setLocation(""); setStaffCount("");
    },
    onError: (err: any) => toast.error(err.message),
  });

  const deleteCanteen = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("canteens").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Canteen deleted");
      qc.invalidateQueries({ queryKey: ["canteens"] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  return (
    <AppLayout title="Canteens">
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Manage all your canteens</p>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5" size="sm">
                <Plus className="w-4 h-4" /> Add Canteen
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add New Canteen</DialogTitle></DialogHeader>
              <div className="space-y-4 mt-2">
                <div>
                  <Label className="text-xs">Canteen Name *</Label>
                  <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Plant A Canteen" />
                </div>
                <div>
                  <Label className="text-xs">Location</Label>
                  <Input value={location} onChange={e => setLocation(e.target.value)} placeholder="e.g. Building A, Ground Floor" />
                </div>
                <div>
                  <Label className="text-xs">Number of Staff</Label>
                  <Input type="number" value={staffCount} onChange={e => setStaffCount(e.target.value)} placeholder="e.g. 10" />
                </div>
                <Button
                  className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
                  onClick={() => addCanteen.mutate()}
                  disabled={addCanteen.isPending}
                >
                  {addCanteen.isPending ? "Adding..." : "Add Canteen"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : canteens?.length === 0 ? (
          <Card className="border-none shadow-sm">
            <CardContent className="p-8 text-center">
              <Building2 className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No canteens yet. Add your first canteen!</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {canteens?.map((c: any) => (
              <Card key={c.id} className="border-none shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
                        <Building2 className="w-5 h-5 text-accent" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">{c.name}</p>
                        <p className="text-xs text-muted-foreground">{c.location || "No location"}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => deleteCanteen.mutate(c.id)}
                      className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-1 mt-3 text-xs text-muted-foreground">
                    <Users className="w-3.5 h-3.5" />
                    <span>{c.staff_count || 0} staff</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
