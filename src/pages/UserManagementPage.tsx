import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useCanteens } from "@/hooks/useSupabaseData";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Shield, Trash2, UserCheck } from "lucide-react";
import { toast } from "sonner";

const ROLE_COLORS: Record<string, string> = {
  owner: "bg-destructive/10 text-destructive border-destructive/20",
  manager: "bg-accent/10 text-accent border-accent/20",
  cashier: "bg-success/10 text-success border-success/20",
};

export default function UserManagementPage() {
  const { isOwner } = useAuth();
  const { data: canteens } = useCanteens();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"manager" | "cashier">("cashier");
  const [canteenId, setCanteenId] = useState("");

  // Fetch all user roles
  const { data: userRoles, isLoading } = useQuery({
    queryKey: ["userRoles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("id, user_id, role, canteen_id, created_at");
      if (error) throw error;
      return data;
    },
    enabled: isOwner,
  });

  const createUser = useMutation({
    mutationFn: async () => {
      if (!email || !password) throw new Error("Email and password required");
      if ((role === "manager" || role === "cashier") && !canteenId) {
        throw new Error("Select a canteen for this role");
      }

      // Create auth user via admin API (requires service_role — done via Supabase Edge Function)
      // For now, we use signUp then assign role
      const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (signUpErr) throw signUpErr;
      if (!signUpData.user) throw new Error("Failed to create user");

      const { error: roleErr } = await supabase.from("user_roles").insert({
        user_id: signUpData.user.id,
        role,
        canteen_id: canteenId || null,
      });
      if (roleErr) throw roleErr;

      return signUpData.user;
    },
    onSuccess: () => {
      toast.success("User created! They'll receive a confirmation email.");
      qc.invalidateQueries({ queryKey: ["userRoles"] });
      setDialogOpen(false);
      setEmail(""); setPassword(""); setRole("cashier"); setCanteenId("");
    },
    onError: (err: any) => toast.error(err.message),
  });

  const revokeRole = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("user_roles").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role revoked");
      qc.invalidateQueries({ queryKey: ["userRoles"] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const getCanteenName = (id: string | null) => {
    if (!id) return "All canteens";
    return canteens?.find((c: any) => c.id === id)?.name || id.slice(0, 8);
  };

  return (
    <AppLayout title="User Management">
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">
              Manage who can access the system and what they can do.
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5" size="sm">
                <Plus className="w-4 h-4" /> Add User
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Create New User</DialogTitle></DialogHeader>
              <div className="space-y-4 mt-2">
                <div>
                  <Label className="text-xs">Email address</Label>
                  <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="staff@company.com" />
                </div>
                <div>
                  <Label className="text-xs">Temporary password</Label>
                  <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Min 8 characters" />
                </div>
                <div>
                  <Label className="text-xs">Role</Label>
                  <Select value={role} onValueChange={(v: any) => setRole(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manager">Manager — full access to one canteen</SelectItem>
                      <SelectItem value="cashier">Cashier — POS only for one canteen</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Assign to canteen</Label>
                  <Select value={canteenId} onValueChange={setCanteenId}>
                    <SelectTrigger><SelectValue placeholder="Select canteen..." /></SelectTrigger>
                    <SelectContent>
                      {canteens?.map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
                  onClick={() => createUser.mutate()}
                  disabled={createUser.isPending}
                >
                  {createUser.isPending ? "Creating..." : "Create User"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Role legend */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { role: "owner", desc: "Full access to all canteens, users, reports", icon: "👑" },
            { role: "manager", desc: "Full access to their assigned canteen", icon: "🏪" },
            { role: "cashier", desc: "POS billing only for their canteen", icon: "💳" },
          ].map(r => (
            <Card key={r.role} className="border-none shadow-sm">
              <CardContent className="p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span>{r.icon}</span>
                  <Badge variant="outline" className={`text-xs capitalize ${ROLE_COLORS[r.role]}`}>{r.role}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{r.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* User list */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Shield className="w-4 h-4" /> Active Users ({userRoles?.length || 0})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : userRoles?.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No users yet. Add your first team member.</p>
            ) : (
              <div className="space-y-2">
                {userRoles?.map((ur: any) => (
                  <div key={ur.id} className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-muted/40 hover:bg-muted/70 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                        <UserCheck className="w-4 h-4 text-accent" />
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground font-mono">{ur.user_id.slice(0, 16)}…</p>
                        <p className="text-xs text-muted-foreground">{getCanteenName(ur.canteen_id)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={`text-xs capitalize ${ROLE_COLORS[ur.role]}`}>{ur.role}</Badge>
                      <button
                        onClick={() => revokeRole.mutate(ur.id)}
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="Revoke access"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
