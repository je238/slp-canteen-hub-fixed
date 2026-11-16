-- ============================================================
-- EMAIL TO THE OWNERS: 6 PM ESCALATION AND THE 10 PM DAILY REPORT
--
-- 14 Nov 2026, asked for by the owner:
--   · 6 PM IST: any order still waiting for approval goes by email straight
--     to Super Admin / Owner / Admin, with who it is stuck with.
--   · 10 PM IST: one email per day with, per site, the day's numbers, who
--     came at what time (staff attendance), food consumption and the Head
--     Supervisor's entries (plates per meal, wastage).
--
-- The daily-email edge function sends them (Gmail). These functions only
-- gather the data and can be called by the server alone. They read every
-- site, as the Super Admin would: the report functions they reuse check
-- site access, so the Super Admin's identity is set for this one call.
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.email_recipients()
RETURNS TABLE (email TEXT, role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT lower(u.email), ur.role
    FROM public.user_roles ur JOIN auth.users u ON u.id = ur.user_id
   WHERE ur.role IN ('super_admin', 'owner', 'admin') AND u.email IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.email_recipients() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_recipients() TO service_role;

-- ---------- 6 PM: orders still waiting for approval ----------
CREATE OR REPLACE FUNCTION public.email_pending_orders()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x->>'site', x->>'for_date', x->>'req_no'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'site', c.name,
      'req_no', r.req_no,
      'meal', coalesce(m.meal_period, r.meal_period, 'extra'),
      'for_date', coalesce(m.menu_date, r.req_date),
      'raised_at', r.created_at,
      'is_extra', r.is_extra,
      'items', (SELECT count(*) FROM public.requisition_items ri WHERE ri.requisition_id = r.id),
      'waiting_with', CASE WHEN r.head_chef_required AND coalesce(r.head_chef_status, '') <> 'approved'
                           THEN 'Head Chef' ELSE 'Manager' END,
      'raised_by', coalesce(u.raw_user_meta_data->>'full_name', u.email)
    ) x
    FROM public.requisitions r
    JOIN public.canteens c ON c.id = r.canteen_id
    LEFT JOIN public.menu_plans m ON m.id = r.menu_plan_id
    LEFT JOIN auth.users u ON u.id = r.requested_by
    WHERE r.status = 'pending'
      AND coalesce(m.menu_date, r.req_date, (r.created_at AT TIME ZONE 'Asia/Kolkata')::date)
          >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 2
  ) s;
$$;
REVOKE ALL ON FUNCTION public.email_pending_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_pending_orders() TO service_role;

-- ---------- 10 PM: the day, per site ----------
CREATE OR REPLACE FUNCTION public.email_daily_digest(p_date DATE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sa UUID; v_out JSONB := '[]'::jsonb; c RECORD; v_site JSONB;
BEGIN
  SELECT user_id INTO v_sa FROM public.user_roles WHERE role IN ('super_admin', 'owner')
   ORDER BY role = 'super_admin' DESC LIMIT 1;
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_sa, 'role', 'authenticated')::text, true);

  FOR c IN SELECT id, name FROM public.canteens ORDER BY name LOOP
    SELECT jsonb_build_object(
      'site', c.name,
      'summary', (SELECT to_jsonb(d) - 'timeline' FROM public.executive_site_dashboard(p_date) d
                   WHERE d.canteen_id = c.id),
      'meals', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'meal', m.meal_period, 'expected', m.expected_headcount,
                   'actual', coalesce(m.actual_headcount,
                                      (SELECT sum((v)::int) FROM jsonb_each_text(coalesce(m.unit_counts, '{}'::jsonb)) e(k, v)
                                        WHERE v ~ '^\d+$')),
                   'company_punch', m.company_punch_count,
                   'recorded_at', m.actual_recorded_at)
                 ORDER BY CASE m.meal_period WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2
                   WHEN 'evening_snacks' THEN 3 WHEN 'dinner' THEN 4 WHEN 'night_snacks' THEN 5 ELSE 6 END), '[]'::jsonb)
                 FROM public.menu_plans m WHERE m.canteen_id = c.id AND m.menu_date = p_date),
      'wastage', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'meal', m.meal_period, 'dish', coalesce(mi.dish_name, '—'), 'unit_no', w.unit_no,
                     'qty', w.quantity, 'unit', w.unit) ORDER BY m.meal_period, mi.dish_name), '[]'::jsonb)
                   FROM public.menu_unit_wastage w
                   JOIN public.menu_plans m ON m.id = w.menu_plan_id
                   LEFT JOIN public.menu_plan_items mi ON mi.id = w.menu_plan_item_id
                   WHERE w.canteen_id = c.id AND m.menu_date = p_date),
      'consumption', (SELECT coalesce(jsonb_agg(jsonb_build_object('item', label, 'qty', qty, 'unit', unit, 'value', value)
                         ORDER BY value DESC NULLS LAST), '[]'::jsonb)
                       FROM (SELECT * FROM public.consumption_report(c.id, p_date, p_date)
                              WHERE scope = 'item' ORDER BY value DESC NULLS LAST LIMIT 15) t),
      'staff_total', (SELECT count(*) FROM public.staff s WHERE s.canteen_id = c.id AND s.active),
      'attendance', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'name', s.name, 'role', s.role,
                        'shift_start', to_char(s.shift_start, 'HH24:MI'),
                        'in', a.check_in, 'out', a.check_out,
                        'late_min', coalesce(a.late_min, 0), 'early_min', coalesce(a.early_leave_min, 0))
                      ORDER BY a.check_in NULLS LAST, s.name), '[]'::jsonb)
                      FROM public.staff s
                      LEFT JOIN public.attendance a ON a.staff_id = s.id AND a.date = p_date
                      WHERE s.canteen_id = c.id AND s.active)
    ) INTO v_site;
    v_out := v_out || jsonb_build_array(v_site);
  END LOOP;
  RETURN jsonb_build_object('date', p_date, 'sites', v_out);
END;
$$;
REVOKE ALL ON FUNCTION public.email_daily_digest(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_daily_digest(DATE) TO service_role;

-- ---------- The clock ----------
-- The token is never in this file: it is the function secret
-- DAILY_EMAIL_TOKEN and the Vault secret 'daily_email_token'.
DO $$
DECLARE v_call TEXT := $call$
  SELECT net.http_post(
    url     := 'https://djexqeisvrybemkftbxm.supabase.co/functions/v1/daily-email',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-token', coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets
                                            WHERE name = 'daily_email_token' LIMIT 1), '')),
    body    := jsonb_build_object('kind', '%s'),
    timeout_milliseconds := 60000);
$call$;
BEGIN
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname IN ('email-pending-orders-6pm', 'email-daily-report-10pm');
  PERFORM cron.schedule('email-pending-orders-6pm', '30 12 * * *', format(v_call, 'escalation'));  -- 18:00 IST
  PERFORM cron.schedule('email-daily-report-10pm', '30 16 * * *', format(v_call, 'daily'));       -- 22:00 IST
END $$;
