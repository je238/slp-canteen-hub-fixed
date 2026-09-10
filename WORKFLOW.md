> **Scope note (July 2026):** the app was narrowed to the SRS modules.
> POS billing, Kitchen Display, QR ordering, the plate-count corporate
> billing screen, WhatsApp daily report and Fraud Monitor were removed from
> the interface. Sections below that describe those screens are history, not
> current behaviour — headcount now comes from the menu plan, and the live
> modules are: menu & production planning, requisitions (±7%), inventory,
> purchases, invoice scan, vendor bills, stock verification, budgets and
> reports. Their data tables still exist in the database.

# SLP Canteen Hub — Operating Workflow (Sun Pharma Plant 4 / Eicher)

How the canteen runs day-to-day with company-paid meals, and how the system
makes ration theft visible. Written for the owner/manager; the app pages
referenced are in the sidebar.

## 1. The business model: plate-count billing (no POS)

There is no POS at these canteens. Food is served, **plates are counted per
meal**, and the client company (Sun Pharma Plant 4, Eicher) pays monthly at a
contracted per-plate rate.

```
Meal ends → supervisor opens Corporate Billing → Daily Plates
        │
Enters ONE number per meal: "Lunch — 250 plates"   (≈1 minute/day)
        │
System does two things at once:
   • bills the company: 250 × contracted rate
   • deducts stock automatically: 250 × that day's thali recipe
     (Weekly Menu board decides which recipe runs on which weekday)
        │
Month end: Statement tab → Generate Invoice
   • every un-invoiced plate entry of the month is stamped to the invoice
     (an entry can never be billed twice, and invoiced entries lock —
      counts can't be quietly changed afterwards)
   • CSV statement: day-wise and meal-wise plates × rate
        │
Send statement to the company → company pays → Mark Sent → Mark Paid
```

Rules that keep this honest:
- **Per-plate rates are fixed on the account** (Companies & Rates tab); the
  rate is frozen onto each entry, so a later rate change can't rewrite history.
- **Invoiced entries are locked** by the database, not just the UI.
- The menu rotates weekly: the **Weekly Menu board** maps each weekday+meal to
  a thali recipe (defined for 1 plate). Change the board or the recipe when
  the food changes — deduction follows automatically.
- The POS remains available for cash/UPI walk-ins if ever needed; it's not
  part of the company flow.

## 2. Inventory flow (goods in → goods out)

```
Vendor delivers + invoice
        │
[RECEIVE]  Weigh/count what actually arrived — not what the bill says
        │
Invoice Scan page → photo of invoice → AI extracts lines → match to
ingredients → purchase saved as DRAFT with the invoice photo attached
        │
[APPROVE]  Manager reviews draft vs. photo → Confirm Purchase
           → stock goes UP, every line lands in the stock ledger
        │
[SELL]     POS/QR order placed → recipe deduction trigger takes the exact
           ingredient quantities out automatically (stock ledger: 'recipe')
        │
[COUNT]    Stock Audit page → physical count → variances booked to the
           ledger as 'audit' with a reason
```

Every movement is one row in the append-only **stock ledger** with who/why.
Nothing changes stock without a trace.

## 3. Anti-theft: the three numbers that must agree

| # | Number | Where it comes from |
|---|--------|--------------------|
| 1 | What came in | Confirmed purchases (photo-backed invoices) |
| 2 | What should have been used | Orders sold × recipe quantities (automatic) |
| 3 | What's on the shelf | Physical count on the Stock Audit page |

Theft = gaps between these. **Stock Audit → Variance Report tab** shows, per
ingredient and period: purchased, recipe usage, manual adjustments, audit
adjustments and the ₹ value of unexplained loss.

Automatic alarm: any audit shortage worth ≥ ₹300 — or *any* shortage of a
high-value item (ghee, paneer, dry fruits, ≥ ₹300/unit) — instantly creates
an open alert on the **Fraud Monitor** page. It cannot be quietly absorbed;
someone must resolve it by name.

### Audit SOP
- **Daily (5 min):** count only the top-value walkable items — ghee, oil,
  paneer, dry fruits, gas. That's where the loss is.
- **Weekly:** full count of dry store. **Monthly:** everything, on the last
  day, *before* generating the corporate invoice.
- Counts are done by someone who doesn't handle that stock daily, at an
  unannounced time, without looking at the system number first.
- Separate duties: receiver ≠ purchase-entry ≠ auditor. Where staff is short,
  the manager/owner does surprise audits instead.
- Tolerances: ~2–3% on grains/vegetables is normal wastage; anything beyond,
  and anything on high-value items, needs a written reason (the audit form
  forces one).

### Receiving rules (stops vendor-side theft)
- Weigh deliveries; never sign the challan for billed quantity.
- The invoice photo is attached to the purchase — the scanner's totals are
  reconciled against the payable amount, so inflated bills surface.
- Draft purchases only turn into stock when a manager confirms them.

## 4. Prerequisite: thali recipes must exist

The automatic deduction (#2 above) needs **one recipe per meal type** (a
"thali recipe" for 1 plate: e.g. Lunch = 150g rice + 100g dal + 60g atta +
100g sabzi + 10ml oil…), assigned per weekday on the Weekly Menu board.
That's 4 meals × 7 days = at most ~28 recipes, and most days share recipes.
The ingredients master (~115 standard Indian kitchen items) is pre-seeded.
Until recipes exist, plate entries still bill correctly — but the variance
report can only compare purchases vs. audits.

## 5. Month-end checklist

1. Full stock audit (before midnight on the last day).
2. Resolve or escalate every open Fraud Monitor alert.
3. Corporate Billing → each company → Generate Invoice → Export CSV → send.
4. Daily Report / Reports pages for the month's P&L; company credit shows
   as its own payment mode ("company") so cash reconciliation stays clean.
5. Mark invoices Sent, and Paid when the money lands.
