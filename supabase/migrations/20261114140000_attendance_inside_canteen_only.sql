-- ============================================================
-- ATTENDANCE ONLY INSIDE THE CANTEEN
--
-- 14 Nov 2026, asked at Eicher: a staff member standing outside (gate,
-- parking, tea stall) must not be able to mark attendance.
--
-- Before: inside 150 m, plus up to 50 m for the phone's GPS error, with any
-- reading better than 300 m accepted. That is a 200 m circle: the whole
-- block, not the canteen.
--
-- Now:
--   · the circle is the manager's radius and nothing more (default 50 m,
--     can be set as low as 20 m)
--   · no allowance for GPS error is added on top
--   · a reading whose own error is more than 60 m, or more than the circle
--     itself, is refused: a phone that does not know where it is within the
--     circle cannot prove it is inside
--   · the manager's own pin for the canteen must be sharp (checked in the
--     app: 30 m or better)
--
-- A phone's GPS cannot see walls: inside versus just outside one wall is
-- within its error. The selfie on every punch is what settles that.
-- Safe to re-run.
-- ============================================================

ALTER TABLE public.canteens ALTER COLUMN att_radius_m SET DEFAULT 50;
UPDATE public.canteens SET att_radius_m = 50 WHERE att_radius_m = 150;

CREATE OR REPLACE FUNCTION public.set_attendance_location(
  p_canteen_id UUID, p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION, p_radius_m INT DEFAULT 50)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.is_manager_or_above() AND public.can_access_canteen(p_canteen_id)) THEN
    RAISE EXCEPTION 'Sirf Manager canteen ki location set kar sakta hai';
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL OR abs(p_lat) > 90 OR abs(p_lng) > 180 THEN
    RAISE EXCEPTION 'Location sahi nahi mili';
  END IF;
  IF p_radius_m < 20 OR p_radius_m > 300 THEN
    RAISE EXCEPTION 'Daayra 20 se 300 meter ke beech rakho';
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
  v_max_err DOUBLE PRECISION;
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
  -- a reading less sure of itself than the circle cannot show you are in it
  v_max_err := least(60, greatest(v_c.att_radius_m, 25));
  IF coalesce(p_accuracy_m, 9999) > v_max_err THEN
    RAISE EXCEPTION 'Phone ko location theek se nahi mili (% m ki galti). Canteen ke andar 10-20 second ruk kar dobara dabao.',
      round(coalesce(p_accuracy_m, 9999));
  END IF;
  IF coalesce(p_photo, '') = '' THEN RAISE EXCEPTION 'Selfie zaroori hai'; END IF;

  v_dist := public.geo_distance_m(v_c.att_lat, v_c.att_lng, p_lat, p_lng);
  IF v_dist > v_c.att_radius_m THEN
    RAISE EXCEPTION 'Aap canteen ke andar nahi ho (% door). Attendance sirf canteen ke andar lagegi.',
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
