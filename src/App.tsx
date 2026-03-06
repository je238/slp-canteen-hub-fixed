import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProvider } from "@/contexts/AppContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import ProtectedRoute from "@/components/ProtectedRoute";
import LoginPage from "./pages/LoginPage";
import Dashboard from "./pages/Dashboard";
import POSPage from "./pages/POSPage";
import InventoryPage from "./pages/InventoryPage";
import RecipesPage from "./pages/RecipesPage";
import PurchasesPage from "./pages/PurchasesPage";
import InvoiceScanPage from "./pages/InvoiceScanPage";
import ExpensesPage from "./pages/ExpensesPage";
import StaffPage from "./pages/StaffPage";
import ReportsPage from "./pages/ReportsPage";
import StockAuditPage from "./pages/StockAuditPage";
import UserManagementPage from "./pages/UserManagementPage";
import ApiKeysPage from "./pages/ApiKeysPage";
import NotFound from "./pages/NotFound";
import CanteenPage from "./pages/CanteenPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
    },
  },
});

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter>
          <AuthProvider>
            <AppProvider>
              <Toaster />
              <Sonner />
              <Routes>
                {/* Public */}
                <Route path="/login" element={<LoginPage />} />

                {/* Cashier+ */}
                <Route path="/pos" element={
                  <ProtectedRoute minRole="cashier"><POSPage /></ProtectedRoute>
                } />

                {/* Manager+ */}
                <Route path="/" element={
                  <ProtectedRoute minRole="manager"><Dashboard /></ProtectedRoute>
                } />
                <Route path="/inventory" element={
                  <ProtectedRoute minRole="manager"><InventoryPage /></ProtectedRoute>
                } />
                <Route path="/recipes" element={
                  <ProtectedRoute minRole="manager"><RecipesPage /></ProtectedRoute>
                } />
                <Route path="/purchases" element={
                  <ProtectedRoute minRole="manager"><PurchasesPage /></ProtectedRoute>
                } />
                <Route path="/invoice-scan" element={
                  <ProtectedRoute minRole="manager"><InvoiceScanPage /></ProtectedRoute>
                } />
                <Route path="/expenses" element={
                  <ProtectedRoute minRole="manager"><ExpensesPage /></ProtectedRoute>
                } />
                <Route path="/stock-audit" element={
                  <ProtectedRoute minRole="manager"><StockAuditPage /></ProtectedRoute>
                } />
                <Route path="/staff" element={
                  <ProtectedRoute minRole="manager"><StaffPage /></ProtectedRoute>
                } />
                <Route path="/reports" element={
                  <ProtectedRoute minRole="manager"><ReportsPage /></ProtectedRoute>
                } />

                {/* Owner only */}
                <Route path="/users" element={
                  <ProtectedRoute minRole="owner"><UserManagementPage /></ProtectedRoute>
                } />
                <Route path="/api-keys" element={
                  <ProtectedRoute minRole="owner"><ApiKeysPage /></ProtectedRoute>
                } />

                <Route path="/canteens" element={<CanteenPage />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </AppProvider>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;

