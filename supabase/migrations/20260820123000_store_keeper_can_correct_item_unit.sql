-- A unit correction is not a cosmetic rename. 40 kg -> 2 box changes the
-- numeric shelf balance and the denomination of every open FIFO lot. Keep the
-- whole correction in one audited transaction so neither the shelf nor its
-- value is left half-converted.

drop function if exists public.save_inventory_item_edit(
  uuid, numeric, numeric, numeric, numeric, numeric, text, text
);

create or replace function public.save_inventory_item_edit(
  p_ingredient_id uuid,
  p_new_stock numeric,
  p_avg_daily_usage numeric,
  p_reorder_level numeric,
  p_maximum_stock numeric,
  p_rate numeric,
  p_name text,
  p_unit text,
  p_unit_change_confirmed boolean,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_ing public.ingredients%rowtype;
  v_stock jsonb := jsonb_build_object('changed', false);
  v_rate jsonb := jsonb_build_object('changed', false);
  v_rename jsonb := jsonb_build_object('changed', false);
  v_unit jsonb := jsonb_build_object('changed', false);
  v_planning_changed boolean := false;
  v_unit_changed boolean := false;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_shelf_value numeric := 0;
  v_new_rate numeric := 0;
  v_delta numeric := 0;
  v_by_store boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Sign in to edit inventory';
  end if;

  select * into v_ing
  from public.ingredients
  where id = p_ingredient_id
  for update;

  if not found then raise exception 'Unknown item'; end if;
  if not public.can_access_canteen(v_ing.canteen_id) then
    raise exception 'You do not have access to this site';
  end if;
  if not (public.is_admin_editor() or public.is_store_keeper()) then
    raise exception 'Only the store keeper or an admin can edit inventory';
  end if;
  v_by_store := public.is_store_keeper() and not public.is_admin_editor();

  if p_new_stock is null or p_new_stock < 0 then
    raise exception 'Stock cannot be negative';
  end if;
  if p_rate is not null and p_rate < 0 then
    raise exception 'Rate cannot be negative';
  end if;

  p_unit := lower(btrim(coalesce(p_unit, '')));
  if p_unit not in ('kg','gram','litre','ml','piece','dozen','packet','box','bottle','tin','bag','tray') then
    raise exception 'Choose a valid unit';
  end if;

  v_unit_changed := p_unit is distinct from lower(v_ing.unit);
  if v_unit_changed then
    if not coalesce(p_unit_change_confirmed, false) then
      raise exception 'Count the physical stock in the new unit and confirm it first';
    end if;
    if v_reason = '' then
      raise exception 'Reason is required for a unit correction';
    end if;

    select coalesce(sum(qty_remaining * rate), 0)
      into v_shelf_value
    from public.ingredient_batches
    where ingredient_id = p_ingredient_id and qty_remaining > 0;

    if v_shelf_value = 0 then
      v_shelf_value := coalesce(v_ing.current_stock, 0) * coalesce(v_ing.cost_per_unit, 0);
    end if;
    v_new_rate := case
      when p_rate is not null then p_rate
      when p_new_stock > 0 then round(v_shelf_value / p_new_stock, 4)
      else coalesce(v_ing.cost_per_unit, 0)
    end;
    v_delta := p_new_stock - v_ing.current_stock;

    perform public.allow_stock_move();

    -- Old lots remain as immutable receipt history, but no longer carry stock
    -- in the old denomination. One explicit conversion lot carries the new
    -- balance and rate from this point forward.
    update public.ingredient_batches
       set qty_remaining = 0
     where ingredient_id = p_ingredient_id and qty_remaining <> 0;

    if p_new_stock > 0 then
      insert into public.ingredient_batches
        (ingredient_id, canteen_id, supplier_id, purchase_id, batch_no,
         qty_received, qty_remaining, rate, received_at)
      values
        (p_ingredient_id, v_ing.canteen_id, null, null,
         'UNIT-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS'),
         p_new_stock, p_new_stock, v_new_rate, now());
    end if;

    update public.ingredients
       set current_stock = p_new_stock,
           unit = p_unit,
           cost_per_unit = v_new_rate,
           updated_at = now()
     where id = p_ingredient_id;

    -- The numeric delta keeps the ledger/shelf invariant exact. Value is zero:
    -- this is a denomination conversion, not goods received or consumed.
    insert into public.stock_ledger
      (ingredient_id, canteen_id, change_qty, balance_after, reason,
       reference_type, created_by, service_date, value)
    values
      (p_ingredient_id, v_ing.canteen_id, v_delta, p_new_stock,
       format('Unit correction: %s %s -> %s %s. %s',
              v_ing.current_stock, v_ing.unit, p_new_stock, p_unit, v_reason),
       'unit_conversion', auth.uid(),
       (now() at time zone 'Asia/Kolkata')::date, 0);

    insert into public.action_logs
      (user_id, action, entity_type, entity_id, canteen_id, details)
    values
      (auth.uid(), 'ingredient_unit_changed', 'ingredient', p_ingredient_id,
       v_ing.canteen_id,
       jsonb_build_object(
         'item', v_ing.name, 'old_unit', v_ing.unit, 'new_unit', p_unit,
         'old_stock', v_ing.current_stock, 'new_stock', p_new_stock,
         'old_rate', v_ing.cost_per_unit, 'new_rate', v_new_rate,
         'preserved_value', v_shelf_value, 'reason', v_reason,
         'physical_count_confirmed', true, 'by_store_keeper', v_by_store));

    if v_by_store then
      insert into public.notifications
        (canteen_id, target_role, title, body, link, ref_type, ref_id)
      values
        (v_ing.canteen_id, 'admin',
         format('Unit corrected by Store Keeper — %s', v_ing.name),
         format('%s: %s %s -> %s %s. Rate ₹%s/%s. Reason: %s',
                v_ing.name, v_ing.current_stock, v_ing.unit,
                p_new_stock, p_unit, v_new_rate, p_unit, v_reason),
         '/inventory', 'ingredient', p_ingredient_id);
    end if;

    v_stock := jsonb_build_object('changed', v_delta <> 0, 'delta', v_delta, 'balance', p_new_stock);
    v_rate := jsonb_build_object('changed', v_new_rate is distinct from v_ing.cost_per_unit,
                                 'was', v_ing.cost_per_unit, 'now', v_new_rate,
                                 'lots_repriced', 1);
    v_unit := jsonb_build_object('changed', true, 'was', v_ing.unit, 'now', p_unit,
                                 'physical_count_confirmed', true);
  else
    if p_new_stock is distinct from v_ing.current_stock then
      v_stock := public.adjust_stock(p_ingredient_id, p_new_stock, p_reason);
    end if;

    if p_rate is not null and p_rate is distinct from v_ing.cost_per_unit then
      v_rate := public.set_ingredient_rate(p_ingredient_id, p_rate, p_reason);
    end if;
  end if;

  if nullif(btrim(coalesce(p_name, '')), '') is not null
     and btrim(p_name) is distinct from v_ing.name then
    v_rename := public.rename_ingredient(p_ingredient_id, btrim(p_name), p_reason);
  end if;

  if p_avg_daily_usage is distinct from v_ing.avg_daily_usage
     or p_reorder_level is distinct from v_ing.reorder_level
     or p_maximum_stock is distinct from v_ing.maximum_stock then
    perform public.allow_stock_move();
    update public.ingredients
       set avg_daily_usage = p_avg_daily_usage,
           reorder_level = p_reorder_level,
           maximum_stock = p_maximum_stock,
           updated_at = now()
     where id = p_ingredient_id;
    v_planning_changed := true;
  end if;

  return jsonb_build_object(
    'stock', v_stock, 'rate', v_rate, 'rename', v_rename,
    'unit', v_unit, 'planning_changed', v_planning_changed
  );
end;
$function$;

revoke all on function public.save_inventory_item_edit(
  uuid, numeric, numeric, numeric, numeric, numeric, text, text, boolean, text
) from public, anon;
grant execute on function public.save_inventory_item_edit(
  uuid, numeric, numeric, numeric, numeric, numeric, text, text, boolean, text
) to authenticated;

