import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2, UserRound, Users } from "lucide-react";
import { toast } from "sonner";
import AppLayout from "@/components/AppLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useCanteens, useSuppliers } from "@/hooks/useSupabaseData";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ROLES = [
  { value: "admin", label: "Admin", desc: "All sites, users and controls", site: false },
  { value: "ops_manager", label: "Operations Manager / GM", desc: "Reports, budgets and site performance", site: true },
  { value: "unit_manager", label: "Unit Manager", desc: "Menu, approval and wastage", site: true },
  { value: "chef", label: "Chef", desc: "Production, recipe and requisition", site: true },
  { value: "store_keeper", label: "Store Keeper", desc: "Purchase, inventory and issue", site: true },
  { value: "vendor", label: "Vendor", desc: "Own invoices and bills", site: false, supplier: true },
];
const roleName = (role: string) => ROLES.find((r) => r.value === role)?.label || role.replace(/_/g, " ");
const freshForm = () => ({ email: "", password: "", role: "store_keeper", canteen_id: "", supplier_id: "", user_id: "" });
const makePassword = () => `Slp@${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}A9`;

export default function UserManagementPage() {
  const { isOwner, user, rank } = useAuth();
  const { data: canteens = [] } = useCanteens();
  const { data: suppliers = [] } = useSuppliers();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>(freshForm());
  const editing = !!form.user_id;
  const spec = ROLES.find((r) => r.value === form.role);

  const usersQuery = useQuery({
    queryKey: ["userRoles"],
    enabled: isOwner,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("admin-create-user", { method: "GET" });
      if (error) throw new Error(error.message || "Users load nahi hue");
      if (data?.error) throw new Error(data.error);
      return data?.users || [];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!editing && (!form.email || form.password.length < 8)) throw new Error("Email aur minimum 8-character password zaroori hai");
      if (editing && form.password && form.password.length < 8) throw new Error("New password minimum 8 characters ka ho");
      if (spec?.site && !form.canteen_id) throw new Error("Is role ke liye site select karein");
      if (spec?.supplier && !form.supplier_id) throw new Error("Vendor company select karein");
      const { data, error } = await supabase.functions.invoke("admin-create-user", {
        method: editing ? "PATCH" : "POST",
        body: form,
      });
      if (error) throw new Error(error.message || "User save nahi hua");
      if (data?.error) throw new Error(data.error);
    },
    onSuccess: () => {
      toast.success(editing ? "User access update ho gaya" : "User account ready hai");
      qc.invalidateQueries({ queryKey: ["userRoles"] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (target: any) => {
      const { data, error } = await supabase.functions.invoke("admin-create-user", {
        method: "DELETE", body: { user_id: target.user_id },
      });
      if (error) throw new Error(error.message || "User remove nahi hua");
      if (data?.error) throw new Error(data.error);
    },
    onSuccess: () => {
      toast.success("Login aur access dono remove ho gaye");
      qc.invalidateQueries({ queryKey: ["userRoles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = useMemo(() => (usersQuery.data || []).filter((u: any) => {
    const q = search.trim().toLowerCase();
    return (roleFilter === "all" || u.role === roleFilter) &&
      (!q || String(u.email || "").toLowerCase().includes(q) || roleName(u.role).toLowerCase().includes(q));
  }), [usersQuery.data, search, roleFilter]);

  const siteName = (id?: string) => id ? (canteens as any[]).find((c) => c.id === id)?.name || "Unknown site" : "All sites";
  const supplierName = (id?: string) => id ? (suppliers as any[]).find((s) => s.id === id)?.name || "Vendor" : "";
  const openCreate = () => { setForm({ ...freshForm(), password: makePassword() }); setOpen(true); };
  const openEdit = (u: any) => { setForm({ ...u, email: u.email || "", password: "" }); setOpen(true); };

  return (
    <AppLayout title="User Management">
      <div className="space-y-4 animate-fade-in">
        <Card className="border-none shadow-sm">
          <CardContent className="p-4 sm:p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-bold">Team access control</h2>
              <p className="text-sm text-muted-foreground">Kaun login kar sakta hai, kis site par aur kya kaam kar sakta hai.</p>
            </div>
            <Button onClick={openCreate} className="w-full sm:w-auto"><Plus className="mr-2 h-4 w-4" />Naya user</Button>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "Active logins", value: usersQuery.data?.length || 0, icon: Users },
            { label: "Sites assigned", value: new Set((usersQuery.data || []).map((u: any) => u.canteen_id).filter(Boolean)).size, icon: ShieldCheck },
            { label: "Never signed in", value: (usersQuery.data || []).filter((u: any) => !u.last_sign_in_at).length, icon: UserRound },
            { label: "Roles in use", value: new Set((usersQuery.data || []).map((u: any) => u.role)).size, icon: CheckCircle2 },
          ].map((x) => <Card key={x.label} className="border-none shadow-sm"><CardContent className="p-4"><x.icon className="mb-2 h-4 w-4 text-accent" /><p className="text-xl font-bold">{x.value}</p><p className="text-xs text-muted-foreground">{x.label}</p></CardContent></Card>)}
        </div>

        <Card className="border-none shadow-sm">
          <CardContent className="p-4 space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Email ya role search karein" className="pl-9" /></div>
              <Select value={roleFilter} onValueChange={setRoleFilter}><SelectTrigger className="w-full sm:w-56"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Sab roles</SelectItem>{ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent></Select>
            </div>
            {usersQuery.isLoading ? <p className="py-8 text-center text-sm text-muted-foreground">Users load ho rahe hain…</p>
              : usersQuery.error ? <p className="py-8 text-center text-sm text-destructive">{(usersQuery.error as Error).message}</p>
              : rows.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">Koi matching user nahi mila.</p>
              : <div className="grid gap-3 xl:grid-cols-2">{rows.map((u: any) => {
                const protectedUser = u.user_id === user?.id || ({ super_admin: 70, owner: 70, admin: 60 } as any)[u.role] >= rank;
                return <div key={u.id} className="rounded-xl border bg-background p-4">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0"><p className="truncate font-semibold">{u.email || "Email unavailable"}</p><div className="mt-1 flex flex-wrap gap-1.5"><Badge variant="outline">{roleName(u.role)}</Badge><Badge variant="secondary">{u.role === "vendor" ? supplierName(u.supplier_id) : siteName(u.canteen_id)}</Badge></div></div>
                    {!protectedUser && <div className="flex shrink-0 gap-1"><Button variant="ghost" size="icon" onClick={() => openEdit(u)} title="Edit role, site or password"><Pencil className="h-4 w-4" /></Button><Button variant="ghost" size="icon" className="text-destructive" onClick={() => window.confirm(`${u.email} ka login permanently remove karein?`) && remove.mutate(u)} title="Remove login"><Trash2 className="h-4 w-4" /></Button></div>}
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">{u.last_sign_in_at ? `Last login: ${new Date(u.last_sign_in_at).toLocaleString("en-IN")}` : "Abhi tak sign in nahi kiya"}</p>
                </div>;
              })}</div>}
          </CardContent>
        </Card>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{editing ? "User access edit karein" : "Naya team login"}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label>Email</Label><Input type="email" value={form.email} disabled={editing} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div><div className="flex items-center justify-between"><Label>{editing ? "New password (optional)" : "Temporary password"}</Label><Button type="button" variant="ghost" size="sm" onClick={() => setForm({ ...form, password: makePassword() })}><KeyRound className="mr-1 h-3.5 w-3.5" />Generate</Button></div><Input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
            <div><Label>Role</Label><Select value={form.role} onValueChange={(role) => setForm({ ...form, role, canteen_id: "", supplier_id: "" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{ROLES.filter((r) => rank > (({ admin: 60, ops_manager: 50, unit_manager: 40, chef: 30, store_keeper: 20, vendor: 10 } as any)[r.value])).map((r) => <SelectItem key={r.value} value={r.value}><span className="font-medium">{r.label}</span> — {r.desc}</SelectItem>)}</SelectContent></Select></div>
            {spec?.site && <div><Label>Assigned site</Label><Select value={form.canteen_id || ""} onValueChange={(canteen_id) => setForm({ ...form, canteen_id })}><SelectTrigger><SelectValue placeholder="Site choose karein" /></SelectTrigger><SelectContent>{(canteens as any[]).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>}
            {spec?.supplier && <div><Label>Vendor company</Label><Select value={form.supplier_id || ""} onValueChange={(supplier_id) => setForm({ ...form, supplier_id })}><SelectTrigger><SelectValue placeholder="Supplier choose karein" /></SelectTrigger><SelectContent>{(suppliers as any[]).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent></Select></div>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : editing ? "Save changes" : "Create login"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
