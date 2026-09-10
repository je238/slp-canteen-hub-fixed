import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Eye, EyeOff, Lock, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export default function LoginPage() {
  const { signIn, roleData, session } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  // Already signed in (e.g. landed here from a refresh race or a bookmark):
  // don't ask for credentials again.
  useEffect(() => {
    if (session) navigate(roleData?.role === "cashier" ? "/pos" : "/", { replace: true });
  }, [session, roleData, navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { toast.error("Enter email and password"); return; }
    setLoading(true);
    const { error } = await signIn(email, password);
    setLoading(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Welcome back!");
    // Cashiers go straight to POS
    if (roleData?.role === "cashier") {
      navigate("/pos");
    } else {
      navigate("/");
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-orange-50 via-background to-slate-100 flex items-center justify-center p-4">
      <div className="pointer-events-none absolute -left-28 -top-28 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-24 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="text-center space-y-2">
          <div className="mx-auto h-24 w-24 overflow-hidden rounded-2xl border border-orange-100 bg-[#f8f7ef] p-2 shadow-sm">
            <img src="/slp-logo.png" alt="SLP Hospitality logo" className="h-full w-full object-contain" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">SLP Hospitality</h1>
          <p className="text-sm text-muted-foreground">Smart Canteen Management</p>
        </div>

        {/* Form */}
        <div className="rounded-2xl border border-border/80 bg-card/95 p-6 shadow-xl shadow-slate-900/5 backdrop-blur space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Welcome back</h2>
            <p className="text-sm text-muted-foreground mt-0.5">Apne work account se sign in karein</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Email address</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="pl-9"
                  autoComplete="email"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="pl-9 pr-10"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="h-11 w-full bg-accent text-accent-foreground shadow-sm hover:bg-accent/90"
              disabled={loading}
            >
              {loading ? "Signing in..." : "Sign in securely"}
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-muted-foreground">Powered by SLP Hospitality</p>
      </div>
    </div>
  );
}
