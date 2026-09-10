# SLP Canteen Hub

Inventory and canteen management for SLP Hospitality Incorporation.

Runs the daily cycle at Eicher, Dewas (Units 1, 2 and 3): the client's menu
comes in, the kitchen orders against it, the store issues it, and the plates
served are counted and billed.

**Live:** https://slp-canteen-hub-fixed.vercel.app
**Android:** `SLP-Canteen-Hub-v1.2.apk` — a shell over the live site, so every
web deploy reaches every phone without reinstalling.

## The day

1. **Menu in** — the company sends a WhatsApp message, a printed weekly or
   fifteen-day chart, or nothing at all. The manager pastes the text, scans
   the photo, or types it, sets the quantity per dish and the expected
   headcount, and publishes.
2. **Chef** — sees the day meal by meal in cooking order, each dish carrying
   what it takes, and raises the raw-material order.
3. **Manager** — approves. Each line may move by at most ±7%.
4. **Store keeper** — issues against the approval. Stock moves only here.
5. **Kitchen returns** — what was drawn but not cooked goes back, and the
   store keeper accepts it onto the shelf.
6. **Plates served** — counted after service. This is what the company is
   billed on, and what every cost-per-head figure divides by.

## Rules the database enforces

None of these are screen-level checks; they are triggers and row-level
policies, so they hold through the API too.

- Closing stock is calculated from the ledger, never typed. Stock cannot go
  negative.
- The store keeper receives goods and issues them; they cannot type a stock
  figure. A count that disagrees is found by somebody else, through the
  blind audit.
- Only the chef raises an order; the manager who approves it cannot also
  raise it.
- Once a record is in, only an admin or super admin may change it.
- A menu cannot be planned for a day already past. The plate count is
  entered once; only an admin may correct it, and every correction is logged.
- Contracted per-plate rates are admin-only, and are not readable by vendors
  or without signing in.

## Development

```sh
npm install
npm run dev          # local
npm run typecheck    # tsc against tsconfig.app.json — `npx tsc` checks nothing here
npm run build
npx vercel deploy --prod --yes
```

Database migrations live in `supabase/migrations` and are applied with
`npx supabase db query --linked -f <file>`.

The Android wrapper is rebuilt only when permissions or the icon change:

```sh
npx cap sync android
cd android && ./gradlew assembleRelease
```

`android/app/slp-release.keystore` signs the APK and is deliberately not in
this repository. Losing it means every phone must uninstall before it can
take an update.
