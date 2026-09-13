import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProvider } from "@/contexts/AppContext";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import ProtectedRoute from "@/components/ProtectedRoute";
import LoginPage from "./pages/LoginPage";
import NotFound from "./pages/NotFound";

// SRS modules
import MenuPlanningPage from "./pages/MenuPlanningPage";
import RequisitionsPage from "./pages/RequisitionsPage";
import BudgetPage from "./pages/BudgetPage";
import VendorBillsPage from "./pages/VendorBillsPage";
import ReportsCenterPage from "./pages/ReportsCenterPage";
import SitePerformancePage from "./pages/SitePerformancePage";
import ComparisonPage from "./pages/ComparisonPage";
import InventoryPage from "./pages/InventoryPage";
import PurchasesPage from "./pages/PurchasesPage";
import InvoiceScanPage from "./pages/InvoiceScanPage";
import MenuScanPage from "./pages/MenuScanPage";
import DashboardPage from "./pages/DashboardPage";
import { homeFor } from "@/lib/navigation";
import VendorsPage from "./pages/VendorsPage";
import StockAuditPage from "./pages/StockAuditPage";
import RecipesPage from "./pages/RecipesPage";
import ExpensesPage from "./pages/ExpensesPage";
import UserManagementPage from "./pages/UserManagementPage";
import CanteenPage from "./pages/CanteenPage";
import AuditLogPage from "./pages/AuditLogPage";
import ExecutiveAlertsPage from "./pages/ExecutiveAlertsPage";
import CentralKitchenPage from "./pages/CentralKitchenPage";
import MealProfitPage from "./pages/MealProfitPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 30_000,
    },
  },
});

// Every role lands on the screen it actually works from, so nobody starts
// on a page their permissions immediately bounce them off.
function RoleHome() {
  const { roleData, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  return <Navigate to={homeFor(roleData?.role)} replace />;
}

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
                <Route path="/login" element={<LoginPage />} />

                <Route path="/" element={
                  <ProtectedRoute><RoleHome /></ProtectedRoute>
                } />

                <Route path="/dashboard" element={
                  <ProtectedRoute minRole="store_keeper"><DashboardPage /></ProtectedRoute>
                } />

                {/* Planning & approval workflow */}
                <Route path="/menu-planning" element={
                  <ProtectedRoute minRole="chef"><MenuPlanningPage /></ProtectedRoute>
                } />
                <Route path="/menu-scan" element={
                  <ProtectedRoute minRole="unit_manager"><MenuScanPage /></ProtectedRoute>
                } />
                <Route path="/requisitions" element={
                  <ProtectedRoute minRole="store_keeper"><RequisitionsPage /></ProtectedRoute>
                } />

                {/* Store keeper: purchase & inventory modules */}
                <Route path="/inventory" element={
                  <ProtectedRoute minRole="store_keeper"><InventoryPage /></ProtectedRoute>
                } />
                <Route path="/central-kitchen" element={
                  <ProtectedRoute minRole="store_keeper"><CentralKitchenPage /></ProtectedRoute>
                } />
                <Route path="/purchases" element={
                  <ProtectedRoute minRole="store_keeper"><PurchasesPage /></ProtectedRoute>
                } />
                <Route path="/invoice-scan" element={
                  <ProtectedRoute minRole="store_keeper"><InvoiceScanPage /></ProtectedRoute>
                } />
                <Route path="/stock-audit" element={
                  <ProtectedRoute minRole="store_keeper"><StockAuditPage /></ProtectedRoute>
                } />
                <Route path="/vendor-bills" element={
                  <ProtectedRoute minRole="store_keeper"><VendorBillsPage /></ProtectedRoute>
                } />

                {/* Masters */}
                <Route path="/vendors" element={
                  <ProtectedRoute minRole="store_keeper"><VendorsPage /></ProtectedRoute>
                } />
                <Route path="/recipes" element={
                  <ProtectedRoute minRole="chef"><RecipesPage /></ProtectedRoute>
                } />
                <Route path="/expenses" element={
                  <ProtectedRoute minRole="unit_manager"><ExpensesPage /></ProtectedRoute>
                } />

                {/* Budget & reporting */}
                <Route path="/budgets" element={
                  <ProtectedRoute minRole="unit_manager"><BudgetPage /></ProtectedRoute>
                } />
                <Route path="/reports-center" element={
                  <ProtectedRoute minRole="unit_manager"><ReportsCenterPage /></ProtectedRoute>
                } />
                <Route path="/meal-profit" element={
                  <ProtectedRoute minRole="unit_manager"><MealProfitPage /></ProtectedRoute>
                } />
                <Route path="/site-performance" element={
                  <ProtectedRoute minRole="ops_manager"><SitePerformancePage /></ProtectedRoute>
                } />
                <Route path="/comparison" element={
                  <ProtectedRoute minRole="ops_manager"><ComparisonPage /></ProtectedRoute>
                } />

                {/* Administration */}
                <Route path="/canteens" element={
                  <ProtectedRoute minRole="unit_manager"><CanteenPage /></ProtectedRoute>
                } />
                <Route path="/users" element={
                  <ProtectedRoute minRole="admin"><UserManagementPage /></ProtectedRoute>
                } />
                <Route path="/audit-log" element={
                  <ProtectedRoute minRole="ops_manager"><AuditLogPage /></ProtectedRoute>
                } />
                <Route path="/executive-alerts" element={
                  <ProtectedRoute minRole="ops_manager"><ExecutiveAlertsPage /></ProtectedRoute>
                } />

                {/* Vendors have exactly one screen */}
                <Route path="/vendor-portal" element={
                  <ProtectedRoute minRole="vendor"><VendorBillsPage /></ProtectedRoute>
                } />

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
