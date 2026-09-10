-- Best-effort hardening of extension-owned tables. On hosted Supabase the
-- postgres role may lack grant options; verify ACLs (warnings are not errors).
-- Never expose the net schema through PostgREST. The delivery body contains
-- only a single-job, atomic-claim capability, not notification content,
-- subscription keys, VAPID private keys or a service-role credential.
revoke all on net.http_request_queue, net._http_response from public, anon, authenticated;
grant all on net.http_request_queue, net._http_response to service_role;
