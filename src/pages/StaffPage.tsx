import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useStaff, useAddStaff, useCanteens } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Users, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";

const roles = [
  { value: "manager", label: "Canteen Manager" },
  { value: "billing_staff", label: "Billing Staff" },
  { value: "kitchen_staff", label: "Kitchen Staff" },
  { value: "helper", label: "Helper" },
];

export default function StaffPage() {
  const { selectedCanteen } = useAppContext();
  const { data: staffList, isLoading } = useStaff(selectedCanteen);
  const { data: canteens } = useCanteens();
  const addStaff = useAddStaff();
  const [dialogOpen, setDialogOpen] = useState(false);

  const [name, setName] = useState("");
  const [role, setRole] = useState("billing_staff");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [canteenId, setCanteenId] = useState(selectedCanteen !== "all" ? selectedCanteen : "");

  const handleAdd = async () => {
    if (!canteenId || !name) { toast.error("Name and canteen are required"); return; }
    try {
      await addStaff.mutateAsync({ canteen_id: canteenId, name, role, phone: phone || undefined, email: email || undefined });
      toast.success("Staff member added!");
      setDialogOpen(false);
      setName(""); setPhone(""); setEmail("");
    } catch (err: any) { toast.error(err.message); }
  };

  const activeCount = staffList?.filter((s: any) => s.active).length || 0;

  return (
    <AppLayout title="Staff Management">
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-success" />
              <span className="text-sm">{activeCount} Active</span>
            </div>
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm">{staffList?.length || 0} Total</span>
            </div>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5" size="sm"><Plus className="w-4 h-4" /> Add Staff</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add Staff Member</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div><Label className="text-xs">Full Name</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>
                <div><Label className="text-xs">Canteen</Label>
                  <Select value={canteenId} onValueChange={setCanteenId}><SelectTrigger><SelectValue placeholder="Select canteen" /></SelectTrigger>
                    <SelectContent>{canteens?.map((c: any) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div><Label className="text-xs">Role</Label>
                  <Select value={role} onValueChange={setRole}><SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{roles.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div><Label className="text-xs">Phone</Label><Input value={phone} onChange={e => setPhone(e.target.value)} /></div>
                <div><Label className="text-xs">Email</Label><Input value={email} onChange={e => setEmail(e.target.value)} /></div>
                <Button onClick={handleAdd} disabled={addStaff.isPending} className="w-full bg-accent text-accent-foreground hover:bg-accent/90">Add Staff</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        <Card className="border-none shadow-sm">
          <CardContent className="p-0">
            {isLoading ? <p className="p-4 text-sm text-muted-foreground">Loading...</p> : (
              <table className="w-full text-sm">
                <thead><tr className="border-b text-muted-foreground">
                  <th className="text-left py-3 px-4 font-medium">Name</th>
                  <th className="text-left py-3 font-medium">Role</th>
                  <th className="text-left py-3 font-medium">Phone</th>
                  <th className="text-left py-3 font-medium">Email</th>
                  <th className="text-center py-3 font-medium">Status</th>
                </tr></thead>
                <tbody>
                  {staffList?.map((s: any) => (
                    <tr key={s.id} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="py-3 px-4 font-medium">{s.name}</td>
                      <td className="py-3"><Badge variant="secondary" className="text-xs">{roles.find(r => r.value === s.role)?.label || s.role}</Badge></td>
                      <td className="py-3 text-muted-foreground">{s.phone || "—"}</td>
                      <td className="py-3 text-muted-foreground">{s.email || "—"}</td>
                      <td className="py-3 text-center">
                        {s.active ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-success"><UserCheck className="w-3 h-3" /> Active</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><UserX className="w-3 h-3" /> Inactive</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {staffList?.length === 0 && (
                    <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">No staff members. Add your first staff member!</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
