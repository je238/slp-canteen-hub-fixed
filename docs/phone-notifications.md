# Phone notifications — rollout / verification

## Current implementation
- Web Push for compatible browsers and installed Home Screen PWAs.
- Bell → Notifications chalu karo → browser Allow → Test alert.
- Each user's phone must enable independently. No permission prompt on page load.
- iPhone: Safari → Add to Home Screen first; then open that app.
- APK/Capacitor WebView is NOT covered. It needs native push/FCM credentials and a rebuilt APK.
- Sound is the operating system notification sound. Silent/DND, disabled site notifications,
  force-stop, power-off, network loss, battery restrictions can prevent/delay alerts.
- A pending push expires after 24 hours; old events remain in the in-app bell.

## Event addressing
- New requisition → site Manager/GM; existing Admin notification retained.
- Approval → Store Keeper plus existing requester's status notification.
- Rejection/status changes/full issue → existing requester notification.
- Partial issue → Chef; issue summary → site Manager/GM (one per transaction/requisition).
- Kitchen return sent → existing Store Keeper notification.
- Accepted return → Chef/return sender.
- Other existing addressed notification inserts use the same push channel.
- Only users who have enabled this device and still have matching site/role receive a push.

## Security / reliability
- VAPID private signing key is in Supabase Vault. Browser only receives the public key.
- POST Edge Function authentication uses a random per-job credential from the private outbox.
- Atomic job claim prevents concurrent duplicate sends. Notifications use a stable tag on device.
- Jobs retry at bounded intervals, maximum five attempts; push provider acceptance is not proof
  that a particular phone displayed it or sounded.
- Subscriptions are own-user read-only via RLS; registration/removal use checked RPCs.
- Shared-device reassignment deletes the old user's queued jobs. Sign-out revokes subscription.
- Push provider endpoints are allowlisted; redirects are disallowed (SSRF protection).
- Retries run once a minute using pg_cron. Diagnostic jobs expire after 30 days.
- Service worker does not cache inventory/approvals.
- Hosted pg_net tables are owned by supabase_admin; our best-effort ACL revoke
  did not remove their PUBLIC SQL grants. Do not expose the net schema through
  the Data API. Queue bodies carry only a one-job replay-protected capability,
  never signing keys, service-role secrets or notification/subscription content.
- Verified Data API rejects Accept-Profile: net with HTTP 406; only public and
  graphql_public are exposed. Do not add net to exposed schemas.
- No historical notifications were backfilled.

## Verification performed 3 Sep 2026
- Typecheck and production build passed.
- Full Vitest suite: 18 tests passed (including 12 push enrollment/worker tests).
- Database rollback checks passed: own-user RLS, role isolation, invalid endpoint rejection,
  private secret/claim permissions, authenticated single-use claim, shared-device reassignment.
- Live config endpoint returns a public signing key; invalid webhook token returns HTTP 401.
- Retry job succeeded; rollback-only test notification removed by transaction rollback.
- No phone subscribed at verification time. Actual device delivery/sound and native APK
  notifications are NOT verified.
- Browser inspection reached login; authenticated notification UI needs a signed-in session.

## Existing database advisor findings (not changed by this feature)
The project also reports older user_directory/Auth exposure and mutable-search-path warnings.
Review separately before broader rollout:
https://supabase.com/docs/guides/database/database-linter?lint=0002_auth_users_exposed

Push-specific notices are expected service-only RLS-without-client-policy on web_push_jobs
and intentionally checked SECURITY DEFINER registration/test RPCs:
https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable
