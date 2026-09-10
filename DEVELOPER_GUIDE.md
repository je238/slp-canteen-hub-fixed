# SLP Canteen Hub — Developer Onboarding & Training Guide

Everything a new developer needs to become productive on this codebase.
Read top to bottom on day one; §9 is the checklist to prove you're set up.

---

## 1. What this system is

A multi-site canteen / institutional-catering ERP for SLP Hospitality.
The company runs canteens inside client factories (Sun Pharma Plant 4,
Eicher). Employees eat **unlimited** food and pay nothing; the client company
is invoiced monthly **per head**. The system therefore has two jobs:

1. **Bill the client correctly** — headcount × contracted rate, locked once invoiced.
2. **Stop ration leaking** — every kilo tracked from vendor bill → store → kitchen,
   with variance checks and automatic alerts.

Everything else (menus, requisitions, budgets, reports) hangs off those two.

---

> **Scope, July 2026:** the product was trimmed to the SRS. Removed from the
> UI (files deleted, database tables intentionally kept): POS billing, Kitchen
> Display, QR ordering, corporate plate-count billing, WhatsApp daily report,
> Fraud Monitor, Staff, API keys, Activity log, the old sales Dashboard and
> Reports page. §6.1 below describes billing history rather than a live screen;
> headcount now comes from `menu_plans`.

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React 18 + Vite + TypeScript | SPA, no SSR |
| UI | shadcn/ui + Tailwind | components in `src/components/ui` — don't hand-roll |
| Data | `@tanstack/react-query` | all server state; no redux |
| Backend | Supabase (Postgres + Auth + Storage + Edge Functions) | **the DB is the real backend** |
| Charts | recharts | |
| Mobile | Capacitor (Android) | `android/`, wraps the live URL |
| Hosting | Vercel | `vercel deploy --prod --yes` |

**Key idea:** business rules live in Postgres (RLS policies, triggers,
`SECURITY DEFINER` RPCs), not in React. The browser holds a public key that any
user can read, so anything enforced only in JavaScript is not enforced at all.

---

## 3. Local setup

```bash
git clone <repo>            # no git remote configured yet — copy the folder
cd slp-canteen-hub-fixed
npm install
cp .env.example .env.local  # if missing, ask the owner for the values
npm run dev                 # http://localhost:5173
```

`.env.local` overrides `.env`. It needs:

```
VITE_SUPABASE_URL="https://<project>.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="<anon key>"
VITE_SUPABASE_PROJECT_ID="<project ref>"
```

Only `VITE_`-prefixed vars reach the browser. **Never put a service-role key
in this file.**

### Supabase CLI

```bash
npx supabase login                 # must be the account that OWNS the project
npx supabase link --project-ref <ref>
npx supabase db query --linked --yes -f supabase/migrations/<file>.sql
```

> **Known trap:** this machine's CLI login flips between two Google accounts and
> starts returning `403 LegacyDbConfigLoginRoleStatusError`. Check with
> `npx supabase orgs list` before applying anything. The permanent fix is a
> Personal Access Token in `SUPABASE_ACCESS_TOKEN`.

---

## 4. Repository map

```
src/
  pages/            one file per screen, always wrapped in <AppLayout>
  components/       shared UI; ui/ is shadcn, don't edit generated files
  hooks/
    useSupabaseData.ts   core: ingredients, orders, purchases, ledger
    useSrsData.ts        SRS modules: menus, requisitions, budgets, vendor bills
    useCorporateBilling.ts  plate-count billing + weekly menu board
    useKitchenOrders.ts     KDS + QR order flows
  contexts/
    AuthContext.tsx   session + role + rank  (start here)
    AppContext.tsx    selected site, sidebar state
supabase/
  migrations/       timestamped SQL, applied in order
  functions/        Deno edge functions (ocr-invoice, admin-create-user)
android/            Capacitor shell
WORKFLOW.md         how the business runs (read this too)
```

---

## 5. The role model — read before touching any policy

Seven roles, ranked. The same ranks exist in TypeScript (`ROLE_RANK` in
`AuthContext.tsx`) and SQL (`public.role_rank()`). **If you change one, change
both.**

| Role | Rank | Can do |
|---|---|---|
| `super_admin` (legacy `owner`) | 70 | everything, weekly reports |
| `admin` | 60 | all sites, user management |
| `ops_manager` | 50 | budgets, reports across assigned sites |
| `unit_manager` (legacy `manager`) | 40 | menus, approvals, one site |
| `chef` (legacy `cashier`) | 30 | production, requisitions |
| `store_keeper` | 20 | purchases, stock in/out, issue |
| `vendor` | 10 | uploads own bills only |

SQL helpers (all `SECURITY DEFINER`, `search_path` pinned):
`my_rank()`, `is_super_admin()`, `is_owner()` (=admin+), `is_manager_or_above()`,
`is_store_keeper_or_above()`, `is_chef()`, `is_vendor()`, `my_supplier_id()`,
`can_access_canteen(uuid)`.

Site scoping: rank ≥ 60 sees every site; others get their `user_roles.canteen_id`
plus any rows in `user_sites` (used for ops managers covering several sites).

---

## 6. The four core flows

### 6.1 Billing (no POS)
`meal_entries` holds one row per **company + date + meal** with `plates`
(headcount) and a `rate` frozen at entry time. `amount` is a generated column.
`generate_corporate_invoice_from_meals()` stamps a month's un-invoiced rows onto
one `corporate_invoices` row; the `process_meal_entry` trigger then **refuses**
any edit or delete of a stamped row. Rate is forced server-side by
`enforce_meal_entry_rate` — a client-supplied rate is ignored.

### 6.2 Goods in
Vendor bill → `vendor_bills` (vendor portal) **or** photo → `ocr-invoice` edge
function → `purchases` in `draft`. Stock moves only on
`confirm_purchase(purchase_id)`, which aggregates lines per ingredient (two
lines matching the same ingredient must not both compute from the same base)
and writes `stock_ledger` rows in the same transaction.

### 6.3 Goods out — the approval chain
```
unit_manager: menu_plans (+ expected_headcount) → publish
chef:         menu_plan_items.produced_qty, then requisitions + requisition_items
unit_manager: approved_qty per line, allowed only within ±7%   ← DB trigger
store_keeper: issue_requisition(req_id)  → atomic stock deduction + ledger
```
The ±7% rule is `enforce_requisition_tolerance` on `requisition_items`. A line
may be set to 0 (rejected) but never moved beyond the band — the UI shows the
allowed range, the database is what actually refuses.

### 6.4 Theft detection
- `stock_ledger` is append-only for `authenticated` (SELECT + INSERT policies only).
- Every row carries `created_by DEFAULT auth.uid()`.
- Blind stock audit → shortages → `flag_audit_shortage` trigger auto-creates
  `fraud_alerts` (₹300 floor, or ≥₹50 on high-value items, deduped per day).
- `stock_variance_report(site, from, to)` nets purchases vs consumption vs audits.
- Per-head check in `DailyRegister.tsx`: today's usage ÷ headcount against the
  item's own trailing 14-day average.

---

## 7. Conventions

- **Pages** live in `src/pages/*Page.tsx`, always inside `<AppLayout title=…>`.
- **Data access** only through hooks; never call `supabase` from a page except
  for storage signed URLs.
- **New tables** are reached with `supabase.from("x" as any)` until
  `types.ts` is regenerated (`npx supabase gen types typescript --linked`).
- **Money** is `NUMERIC`, currency is ₹, GST 5% where hard-coded.
- **Every mutation** must check `error` — supabase-js resolves, it does not throw.
- **Commits**: short imperative subject, one feature per commit, no emoji.
- Loose `any` typing is common in older files; new code should be typed better
  but don't refactor the world in a feature PR.

### Adding a table — the checklist
1. New migration `supabase/migrations/<UTC timestamp>_<name>.sql`, idempotent.
2. `ALTER TABLE … ENABLE ROW LEVEL SECURITY` **and write policies.**
   A table with RLS on and no policy is invisible; with RLS off it is wide open.
3. Grant nothing to `anon` unless it is genuinely public.
4. Any function: `SECURITY DEFINER` only when needed, always
   `SET search_path = public`, always `REVOKE ALL … FROM PUBLIC, anon`.
5. Index the columns your queries filter on.
6. Apply to live, then verify with a `SELECT` — do not assume.

---

## 8. Deploying

```bash
npm run build            # must pass
npx tsc --noEmit         # must be 0 errors
vercel deploy --prod --yes
```
The Android app loads the live URL, so a web deploy updates the app too — no
APK rebuild unless native config changes:
```bash
npx cap sync android && cd android && ./gradlew assembleDebug
```
(`android/local.properties` needs `sdk.dir`; it is gitignored.)

---

## 9. Day-one checklist

- [ ] `npm run dev` works and you can log in
- [ ] You can explain what `can_access_canteen()` returns for a `chef`
- [ ] You found where the ±7% rule is enforced (file + function name)
- [ ] You ran a `db query` against a scratch SQL file and read the JSON back
- [ ] You know why business rules cannot live in React here
- [ ] You have read `WORKFLOW.md` and the user guide PDF

---

## 10. Known gaps / next tasks

Ordered by priority. Reviewed by a five-agent audit in July 2026.

1. **Migration history is not tracked.** The live DB was built by hand;
   `fraud_alerts`, `ingredient_usage_log` and the order-number generator exist
   only in production. `supabase db pull` a baseline and adopt CLI-tracked
   migrations before doing anything structural.
2. **IST vs UTC.** `toISOString()` is used for "today" in several places; before
   05:30 IST that is yesterday. `useLedgerSince` also compares a `timestamptz`
   with a bare date string. Centralise a `todayIstIso()` helper and fix callers.
3. **Client-side stock writes remain** in `useUpdateIngredientStock` and the
   audit submit path — move them onto RPCs like `record_stock_issue`.
4. **Audit submit ignores errors** (`StockAuditPage.submitAudit`) — a failed
   write still reports success.
5. **Plate-input reset** in `CorporateBillingPage` wipes unsaved values for
   other companies when one saves.
6. **`ocr-invoice` has no auth check** — anyone with the anon key can burn the
   Gemini quota. Mirror the JWT check in `admin-create-user`.
7. **Blind audit is client-side only**; `current_stock` is sent to the browser.
   Move variance computation into an RPC.
8. Batches/FIFO tables exist (`ingredient_batches`) but nothing writes them yet.
9. `types.ts` is stale — regenerate after the pending migrations land.

---

## 11. Who to ask

Product/business decisions: the owner. Anything about how the canteen actually
operates is in `WORKFLOW.md` and the bilingual user-guide PDF; when the code and
those documents disagree, the documents describe the intent and the code is
probably the bug.
