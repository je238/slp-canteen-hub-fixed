-- A store keeper may register a supplier for a site they are assigned to.
-- Updating or deleting an existing vendor remains manager/admin controlled by
-- the existing suppliers_manager_write policy.
create policy suppliers_store_keeper_insert
on public.suppliers
for insert
to authenticated
with check (
  public.my_rank() = 20
  and canteen_id is not null
  and public.can_access_canteen(canteen_id)
);
