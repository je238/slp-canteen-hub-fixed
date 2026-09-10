create index if not exists idx_menu_plans_actual_recorded_by
  on public.menu_plans (actual_recorded_by)
  where actual_recorded_by is not null;

create index if not exists idx_menu_plans_punch_recorded_by
  on public.menu_plans (punch_recorded_by)
  where punch_recorded_by is not null;
