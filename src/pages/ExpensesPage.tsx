import { useState } from "react";
import AppLayout from "@/components/AppLayout";
import { useAppContext } from "@/contexts/AppContext";
import { useExpenses, useAddExpense } from "@/hooks/useSupabaseData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Wallet } from "lucide-react";
import { toast } from "sonner";

const expenseCategories = ["Utilities", "Maintenance", "Transport", "Cleaning", "Equipment", "Salary", "Miscellaneous"];

export default function ExpensesPage() {
  const { selectedCanteen } = useAppContext();
  const { data: expenses, isLoading } = useExpenses(selectedCanteen);
  const addExpense = useAddExpense();
  const [dialogOpen, setDialogOpen] = useState(false);

  const [category, setCategory] = useState("Utilities");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);

  const handleAdd = async () => {
    if (selectedCanteen === "all") { toast.error("Select a canteen first"); return; }
    if (!amount) { toast.error("Enter amount"); return; }
    try {
      await addExpense.mutateAsync({ canteen_id: selectedCanteen, category, description: description || undefined, amount, expense_date: date });
      toast.success("Expense added!");
      setDialogOpen(false);
      setDescription("");
      setAmount(0);
    } catch (err: any) { toast.error(err.message); }
  };

  const totalExpenses = expenses?.reduce((s: number, e: any) => s + Number(e.amount), 0) || 0;

  // Group by category
  const byCategory = expenses?.reduce((acc: Record<string, number>, e: any) => {
    acc[e.category] = (acc[e.category] || 0) + Number(e.amount);
    return acc;
  }, {} as Record<string, number>) || {};

  return (
    <AppLayout title="Expense Tracking">
      <div className="space-y-4 animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-2xl font-bold">₹{totalExpenses.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Total Expenses</p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90 gap-1.5" size="sm"><Plus className="w-4 h-4" /> Add Expense</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add Expense</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div><Label className="text-xs">Category</Label>
                  <Select value={category} onValueChange={setCategory}><SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{expenseCategories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div><Label className="text-xs">Description</Label><Input value={description} onChange={e => setDescription(e.target.value)} /></div>
                <div><Label className="text-xs">Amount (₹)</Label><Input type="number" value={amount} onChange={e => setAmount(Number(e.target.value))} /></div>
                <div><Label className="text-xs">Date</Label><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
                <Button onClick={handleAdd} disabled={addExpense.isPending} className="w-full bg-accent text-accent-foreground hover:bg-accent/90">Add Expense</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {/* Category summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(byCategory).map(([cat, total]) => (
            <Card key={cat} className="border-none shadow-sm">
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{cat}</p>
                <p className="text-lg font-bold">₹{(total as number).toLocaleString()}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Expense list */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">Recent Expenses</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <p className="text-sm text-muted-foreground">Loading...</p> : (
              <table className="w-full text-sm">
                <thead><tr className="border-b text-muted-foreground">
                  <th className="text-left py-2 font-medium">Date</th>
                  <th className="text-left py-2 font-medium">Category</th>
                  <th className="text-left py-2 font-medium">Description</th>
                  <th className="text-right py-2 font-medium">Amount</th>
                </tr></thead>
                <tbody>
                  {expenses?.map((e: any) => (
                    <tr key={e.id} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="py-2">{new Date(e.expense_date).toLocaleDateString()}</td>
                      <td className="py-2">{e.category}</td>
                      <td className="py-2 text-muted-foreground">{e.description || "—"}</td>
                      <td className="py-2 text-right font-medium">₹{Number(e.amount).toLocaleString()}</td>
                    </tr>
                  ))}
                  {expenses?.length === 0 && (
                    <tr><td colSpan={4} className="py-8 text-center text-muted-foreground">No expenses recorded</td></tr>
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
