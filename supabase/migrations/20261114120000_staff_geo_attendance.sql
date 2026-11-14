-- ============================================================
-- STAFF ATTENDANCE FROM THEIR OWN PHONE, ONLY AT THE CANTEEN
--
-- 14 Nov 2026: canteen staff were not coming on time and nobody had a
-- record. Each staff member now marks "Aaya" / "Gaya" on their own phone:
--
--   · They sign in with mobile number + PIN on a separate page. They get NO
--     app account: an app account would let a helper read stock, bills and
--     rates through the API. Their phone only ever talks to the
--     staff-attendance edge function, which uses the functions below.
--   · The phone's GPS must put them inside the canteen's circle (set by the
--     manager standing in the canteen). The distance is worked out here, on
--     the server, and stored with every punch.
--   · A selfie is taken with every punch, so a friend cannot mark it for
--     them. GPS on a phone can be faked with an app; the selfie is what
--     catches that.
--   · Each staff member has their own shift start; arriving after start +
--     grace minutes is recorded as late, with the minutes.
--
-- Corrections are the manager's, through the table policies (logged).
-- Safe to re-run.
-- ============================================================

-- ---------- Where the canteen is ----------
ALTER TABLE public.canteens
  ADD COLUMN IF NOT EXISTS att_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS att_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS att_radius_m INT NOT NULL DEFAULT 150;

-- ---------- Who works there and when ----------
ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS shift_start TIME,
  ADD COLUMN IF NOT EXISTS shift_end TIME,
  ADD COLUMN IF NOT EXISTS grace_min INT NOT NULL DEFAULT 10;
CREATE UNIQUE INDEX IF NOT EXISTS staff_active_phone_uniq
  ON public.staff (phone) WHERE active AND phone IS NOT NULL;

-- PINs live apart from staff, which everyone at the site can read.
CREATE TABLE IF NOT EXISTS public.staff_pins (
  staff_id     UUID PRIMARY KEY REFERENCES public.staff(id) ON DELETE CASCADE,
  pin_hash     TEXT NOT NULL,
  failed       INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.staff_pins ENABLE ROW LEVEL SECURITY;   -- no policies: server only
REVOKE ALL ON public.staff_pins FROM anon, authenticated;

-- ---------- What happened each day ----------
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS shift_start  TIME,
  ADD COLUMN IF NOT EXISTS late_min     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS in_lat       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS in_lng       DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS in_dist_m    INT,
  ADD COLUMN IF NOT EXISTS in_accuracy_m INT,
  ADD COLUMN IF NOT EXISTS in_photo     TEXT,
  ADD COLUMN IF NOT EXISTS out_lat      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS out_lng      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS out_dist_m   INT,
  ADD COLUMN IF NOT EXISTS out_accuracy_m INT,
  ADD COLUMN IF NOT EXISTS out_photo    TEXT,
  ADD COLUMN IF NOT EXISTS early_leave_min INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS note         TEXT,
  ADD COLUMN IF NOT EXISTS edited_by    UUID,
  ADD COLUMN IF NOT EXISTS edited_at    TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS attendance_site_day ON public.attendance (canteen_id, date);

-- Anyone at the site could write attendance before. Only a manager may now
-- touch it by hand; staff punches come in through the server.
DROP POLICY IF EXISTS "attendance_staff_all" ON public.attendance;
DROP POLICY IF EXISTS "attendance_select" ON public.attendance;
DROP POLICY IF EXISTS "attendance_write" ON public.attendance;
DROP POLICY IF EXISTS "attendance_manager_select" ON public.attendance;
DROP POLICY IF EXISTS "attendance_manager_write" ON public.attendance;
CREATE POLICY "attendance_manager_select" ON public.attendance FOR SELECT TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));
CREATE POLICY "attendance_manager_write" ON public.attendance FOR ALL TO authenticated
  USING (public.is_manager_or_above() AND public.can_access_canteen(canteen_id))
  WITH CHECK (public.is_manager_or_above() AND public.can_access_canteen(canteen_id));

-- ---------- Selfies ----------
INSERT INTO storage.buckets (id, name, public)
VALUES ('attendance', 'attendance', false)
ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS "attendance_photos_manager_read" ON storage.objects;
CREATE POLICY "attendance_photos_manager_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'attendance'
         AND public.is_manager_or_above()
         AND (storage.foldername(name))[1] IN (SELECT c.id::text FROM public.canteens c
                                               WHERE public.can_access_canteen(c.id)));

-- ---------- Helpers ----------
CREATE OR REPLACE FUNCTION public.geo_distance_m(lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION,
                                                 lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION)
RETURNS DOUBLE PRECISION LANGUAGE sql IMMUTABLE AS $$
  SELECT 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

CREATE OR REPLACE FUNCTION public.normalize_phone(p TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '');
$$;

-- ---------- Manager: set the canteen's location ----------
CREATE OR REPLACE FUNCTION public.set_attendance_location(
  p_canteen_id UUID, p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION, p_radius_m INT DEFAULT 150)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.is_manager_or_above() AND public.can_access_canteen(p_canteen_id)) THEN
    RAISE EXCEPTION 'Sirf Manager canteen ki location set kar sakta hai';
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL OR abs(p_lat) > 90 OR abs(p_lng) > 180 THEN
    RAISE EXCEPTION 'Location sahi nahi mili';
  END IF;
  IF p_radius_m < 30 OR p_radius_m > 2000 THEN
    RAISE EXCEPTION 'Daayra 30 se 2000 meter ke beech rakho';
  END IF;
  UPDATE public.canteens SET att_lat = p_lat, att_lng = p_lng, att_radius_m = p_radius_m
   WHERE id = p_canteen_id;
  INSERT INTO public.action_logs(user_id, action, entity_type, entity_id, canteen_id, details)
  VALUES (auth.uid(), 'attendance_location_set', 'canteen', p_canteen_id, p_canteen_id,
          jsonb_build_object('lat', p_lat, 'lng', p_lng, 'radius_m', p_radius_m));
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_attendance_location(UUID, DOUBLE PRECISION, DOUBLE PRECISION, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_attendance_location(UUID, DOUBLE PRECISION, DOUBLE PRECISION, INT) TO authenticated;

-- ---------- Manager: set a staff member's PIN ----------
CREATE OR REPLACE FUNCTION public.set_staff_pin(p_staff_id UUID, p_pin TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_site UUID;
BEGIN
  SELECT canteen_id INTO v_site FROM public.staff WHERE id = p_staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff nahi mila'; END IF;
  IF NOT (public.is_manager_or_above() AND public.can_access_canteen(v_site)) THEN
    RAISE EXCEPTION 'Sirf Manager PIN set kar sakta hai';
  END IF;
  IF coalesce(p_pin, '') !~ '^\d{4,6}$' THEN RAISE EXCEPTION 'PIN 4 se 6 ankon ka hona chahiye'; END IF;
  INSERT INTO public.staff_pins (staff_id, pin_hash, failed, locked_until, updated_at)
  VALUES (p_staff_id, extensions.crypt(p_pin, extensions.gen_salt('bf')), 0, NULL, now())
  ON CONFLICT (staff_id) DO UPDATE
    SET pin_hash = EXCLUDED.pin_hash, failed = 0, locked_until = NULL, updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.set_staff_pin(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_pin(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_with_pin(p_canteen_id UUID)
RETURNS TABLE (staff_id UUID, has_pin BOOLEAN, locked BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, p.staff_id IS NOT NULL, coalesce(p.locked_until > now(), false)
    FROM public.staff s LEFT JOIN public.staff_pins p ON p.staff_id = s.id
   WHERE s.canteen_id = p_canteen_id
     AND public.is_manager_or_above() AND public.can_access_canteen(p_canteen_id);
$$;
REVOKE ALL ON FUNCTION public.staff_with_pin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_with_pin(UUID) TO authenticated;

-- ---------- Server only: sign in ----------
-- Five wrong PINs lock the number for 15 minutes.
CREATE OR REPLACE FUNCTION public.staff_attendance_login(p_phone TEXT, p_pin TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_s public.staff%ROWTYPE; v_p public.staff_pins%ROWTYPE;
BEGIN
  SELECT * INTO v_s FROM public.staff
   WHERE active AND public.normalize_phone(phone) = public.normalize_phone(p_phone)
   ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ye mobile number staff list mein nahi hai. Manager se judwao.'; END IF;
  SELECT * INTO v_p FROM public.staff_pins WHERE staff_id = v_s.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aapka PIN abhi set nahi hua. Manager se PIN lo.'; END IF;
  IF v_p.locked_until > now() THEN
    RAISE EXCEPTION 'Galat PIN zyada baar daala. % minute baad try karo.',
      ceil(extract(epoch FROM v_p.locked_until - now()) / 60);
  END IF;
  IF extensions.crypt(coalesce(p_pin, ''), v_p.pin_hash) <> v_p.pin_hash THEN
    UPDATE public.staff_pins
       SET failed = failed + 1,
           locked_until = CASE WHEN failed + 1 >= 5 THEN now() + interval '15 minutes' END
     WHERE staff_id = v_s.id;
    RETURN jsonb_build_object('error', 'PIN galat hai');
  END IF;
  UPDATE public.staff_pins SET failed = 0, locked_until = NULL WHERE staff_id = v_s.id;
  RETURN jsonb_build_object('staff_id', v_s.id,
                            'pin_ver', floor(extract(epoch FROM v_p.updated_at))::bigint);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_attendance_login(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_attendance_login(TEXT, TEXT) TO service_role;

-- ---------- Server only: who am I, what have I done today ----------
CREATE OR REPLACE FUNCTION public.staff_attendance_status(p_staff_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'staff_id', s.id, 'name', s.name, 'role', s.role, 'active', s.active,
    'site', c.name, 'canteen_id', c.id,
    'shift_start', to_char(s.shift_start, 'HH24:MI'), 'shift_end', to_char(s.shift_end, 'HH24:MI'),
    'grace_min', s.grace_min,
    'location_set', c.att_lat IS NOT NULL, 'radius_m', c.att_radius_m,
    'pin_ver', floor(extract(epoch FROM p.updated_at))::bigint,
    'today', (SELECT to_jsonb(a) - 'in_photo' - 'out_photo' FROM public.attendance a
               WHERE a.staff_id = s.id
                 AND a.date = (now() AT TIME ZONE 'Asia/Kolkata')::date),
    'open', (SELECT jsonb_build_object('date', a.date, 'check_in', a.check_in) FROM public.attendance a
              WHERE a.staff_id = s.id AND a.check_in IS NOT NULL AND a.check_out IS NULL
                AND a.check_in > now() - interval '20 hours'
              ORDER BY a.check_in DESC LIMIT 1))
  FROM public.staff s
  JOIN public.canteens c ON c.id = s.canteen_id
  LEFT JOIN public.staff_pins p ON p.staff_id = s.id
  WHERE s.id = p_staff_id;
$$;
REVOKE ALL ON FUNCTION public.staff_attendance_status(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_attendance_status(UUID) TO service_role;

-- ---------- Server only: mark Aaya / Gaya ----------
CREATE OR REPLACE FUNCTION public.staff_attendance_punch(
  p_staff_id UUID, p_kind TEXT,
  p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION, p_accuracy_m DOUBLE PRECISION,
  p_photo TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_s public.staff%ROWTYPE; v_c public.canteens%ROWTYPE; v_a public.attendance%ROWTYPE;
  v_now_ist TIMESTAMP := now() AT TIME ZONE 'Asia/Kolkata';
  v_today DATE := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_dist DOUBLE PRECISION; v_late INT := 0; v_early INT := 0; v_end TIMESTAMP;
BEGIN
  SELECT * INTO v_s FROM public.staff WHERE id = p_staff_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aapka naam staff list mein active nahi hai'; END IF;
  SELECT * INTO v_c FROM public.canteens WHERE id = v_s.canteen_id;
  IF v_c.att_lat IS NULL THEN
    RAISE EXCEPTION 'Canteen ki location abhi set nahi hui. Manager ko bolo.';
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RAISE EXCEPTION 'Phone ki location nahi mili. Location (GPS) on karo.';
  END IF;
  IF coalesce(p_accuracy_m, 9999) > 300 THEN
    RAISE EXCEPTION 'GPS kamzor hai (% m). Khuli jagah par jaakar dobara try karo.', round(coalesce(p_accuracy_m, 9999));
  END IF;
  IF coalesce(p_photo, '') = '' THEN RAISE EXCEPTION 'Selfie zaroori hai'; END IF;

  v_dist := public.geo_distance_m(v_c.att_lat, v_c.att_lng, p_lat, p_lng);
  -- the phone's own error margin is allowed for, up to 50 m
  IF v_dist > v_c.att_radius_m + least(coalesce(p_accuracy_m, 0), 50) THEN
    RAISE EXCEPTION 'Aap canteen se % door ho. Attendance sirf canteen par lagegi.',
      CASE WHEN v_dist >= 1000 THEN round((v_dist / 1000)::numeric, 1) || ' km'
           ELSE round(v_dist) || ' meter' END;
  END IF;

  IF p_kind = 'in' THEN
    SELECT * INTO v_a FROM public.attendance WHERE staff_id = v_s.id AND date = v_today;
    IF FOUND AND v_a.check_in IS NOT NULL THEN
      RAISE EXCEPTION 'Aaj ki attendance pehle hi % par lag chuki hai',
        to_char(v_a.check_in AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM');
    END IF;
    IF v_s.shift_start IS NOT NULL THEN
      v_late := floor(extract(epoch FROM v_now_ist - (v_today + v_s.shift_start)) / 60);
      IF v_late <= v_s.grace_min THEN v_late := 0; END IF;
    END IF;
    INSERT INTO public.attendance (staff_id, canteen_id, date, status, check_in, shift_start, late_min,
                                   in_lat, in_lng, in_dist_m, in_accuracy_m, in_photo)
    VALUES (v_s.id, v_s.canteen_id, v_today, CASE WHEN v_late > 0 THEN 'late' ELSE 'present' END,
            now(), v_s.shift_start, v_late, p_lat, p_lng, round(v_dist), round(p_accuracy_m), p_photo)
    ON CONFLICT (staff_id, date) DO UPDATE
      SET status = EXCLUDED.status, check_in = EXCLUDED.check_in, shift_start = EXCLUDED.shift_start,
          late_min = EXCLUDED.late_min, in_lat = EXCLUDED.in_lat, in_lng = EXCLUDED.in_lng,
          in_dist_m = EXCLUDED.in_dist_m, in_accuracy_m = EXCLUDED.in_accuracy_m, in_photo = EXCLUDED.in_photo;
    RETURN jsonb_build_object('kind', 'in', 'at', now(), 'late_min', v_late, 'dist_m', round(v_dist));
  ELSIF p_kind = 'out' THEN
    -- a night shift closes yesterday's record
    SELECT * INTO v_a FROM public.attendance
     WHERE staff_id = v_s.id AND check_in IS NOT NULL AND check_out IS NULL
       AND check_in > now() - interval '20 hours'
     ORDER BY check_in DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pehle aane (Aaya) ki attendance lagao'; END IF;
    IF v_s.shift_end IS NOT NULL THEN
      v_end := v_a.date + v_s.shift_end;
      IF v_s.shift_start IS NOT NULL AND v_s.shift_end <= v_s.shift_start THEN v_end := v_end + interval '1 day'; END IF;
      v_early := greatest(floor(extract(epoch FROM v_end - v_now_ist) / 60), 0);
    END IF;
    UPDATE public.attendance
       SET check_out = now(), out_lat = p_lat, out_lng = p_lng, out_dist_m = round(v_dist),
           out_accuracy_m = round(p_accuracy_m), out_photo = p_photo, early_leave_min = v_early
     WHERE id = v_a.id;
    RETURN jsonb_build_object('kind', 'out', 'at', now(), 'early_min', v_early, 'dist_m', round(v_dist),
                              'worked_min', floor(extract(epoch FROM now() - v_a.check_in) / 60));
  END IF;
  RAISE EXCEPTION 'Galat request';
END;
$$;
REVOKE ALL ON FUNCTION public.staff_attendance_punch(UUID, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_attendance_punch(UUID, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO service_role;
