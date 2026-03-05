import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Copy, Eye, EyeOff, Key, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "slp_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default function ApiKeysPage() {
  const qc = useQueryClient();
  const [newLabel, setNewLabel] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  const { data: keys, isLoading } = useQuery({
    queryKey: ["apiKeys"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("api_keys")
        .select("id, label, revoked, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const generateApiKey = useMutation({
    mutationFn: async (label: string) => {
      const rawKey = generateKey();
      const hash = await sha256(rawKey);

      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from("api_keys").insert({
        key_hash: hash,
        label,
        created_by: user?.id,
      });
      if (error) throw error;

      return rawKey;
    },
    onSuccess: (key) => {
      setGeneratedKey(key);
      setShowKey(true);
      setNewLabel("");
      qc.invalidateQueries({ queryKey: ["apiKeys"] });
      toast.success("API key generated! Copy it now — it won't be shown again.");
    },
    onError: (err: any) => toast.error(err.message),
  });

  const revokeKey = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("api_keys").update({ revoked: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("API key revoked");
      qc.invalidateQueries({ queryKey: ["apiKeys"] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const copyKey = () => {
    if (generatedKey) {
      navigator.clipboard.writeText(generatedKey);
      toast.success("Copied to clipboard!");
    }
  };

  return (
    <AppLayout title="API Keys">
      <div className="max-w-2xl space-y-5 animate-fade-in">
        <p className="text-sm text-muted-foreground">
          API keys let external systems (like integrations or scripts) access your data securely.
          Keys are stored as SHA-256 hashes — the raw key is only shown once at creation.
        </p>

        {/* Generated key banner */}
        {generatedKey && (
          <Card className="border-accent/50 bg-accent/5">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-accent">
                <Key className="w-4 h-4" />
                New API Key — Copy now, it won't be shown again
              </div>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={showKey ? generatedKey : "•".repeat(generatedKey.length)}
                  className="font-mono text-xs bg-background"
                />
                <Button variant="outline" size="icon" onClick={() => setShowKey(v => !v)}>
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={copyKey}>
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setGeneratedKey(null)}>
                Dismiss
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Generate new key */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Generate New Key</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Key label (e.g. "Reporting Script", "Mobile App")</Label>
              <Input
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                placeholder="My integration"
              />
            </div>
            <Button
              className="gap-1.5 bg-accent text-accent-foreground hover:bg-accent/90"
              onClick={() => generateApiKey.mutate(newLabel)}
              disabled={!newLabel || generateApiKey.isPending}
            >
              <Plus className="w-4 h-4" />
              {generateApiKey.isPending ? "Generating..." : "Generate Key"}
            </Button>
          </CardContent>
        </Card>

        {/* Existing keys */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Active Keys ({keys?.filter(k => !k.revoked).length || 0})</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : keys?.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No API keys yet.</p>
            ) : (
              <div className="space-y-2">
                {keys?.map((key: any) => (
                  <div key={key.id} className="flex items-center justify-between py-2.5 px-3 rounded-lg bg-muted/40">
                    <div className="flex items-center gap-3">
                      <Key className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">{key.label}</p>
                        <p className="text-xs text-muted-foreground">
                          Created {new Date(key.created_at).toLocaleDateString("en-IN")}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={key.revoked
                        ? "bg-muted text-muted-foreground"
                        : "bg-success/10 text-success border-success/20"
                      }>
                        {key.revoked ? "Revoked" : "Active"}
                      </Badge>
                      {!key.revoked && (
                        <button
                          onClick={() => revokeKey.mutate(key.id)}
                          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Usage instructions */}
        <Card className="border-none shadow-sm bg-muted/30">
          <CardContent className="p-4 space-y-2">
            <p className="text-xs font-semibold text-foreground">Using your API key</p>
            <p className="text-xs text-muted-foreground">Include the key in request headers when calling Supabase Edge Functions:</p>
            <pre className="text-xs bg-background rounded p-2 overflow-x-auto border">
{`// HTTP Header
Authorization: Bearer <your-api-key>
x-api-key: slp_<your-api-key>

// In Edge Functions, verify with:
const apiKey = req.headers.get('x-api-key');
const hash = await sha256(apiKey);
// Check hash exists in api_keys table and is not revoked`}
            </pre>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
