-- Historical reconciliation is intentionally exposed only through guarded RPCs.
-- Direct table access would let signed-in clients bypass the role-shaped response.
revoke all on table public.requisition_issue_reconciliations from authenticated;
grant all on table public.requisition_issue_reconciliations to service_role;

-- Keep foreign-key lookups and audit filters inexpensive as reconciliation grows.
create index if not exists idx_issue_reconciliation_submitted_by
  on public.requisition_issue_reconciliations (submitted_by);

create index if not exists idx_issue_reconciliation_reviewed_by
  on public.requisition_issue_reconciliations (reviewed_by)
  where reviewed_by is not null;
