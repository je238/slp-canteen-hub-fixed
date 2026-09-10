-- Evidence photos belong at stock-in, not at issue. Material going to the
-- kitchen has already been approved by the manager, so requiring a second
-- photo at hand-over only slowed the store keeper down. The 'issue' photo
-- type stays valid for anything already recorded; it is simply no longer
-- required. Safe to re-run.
DROP FUNCTION IF EXISTS public.require_issue_photo(UUID, UUID);
