CREATE INDEX IF NOT EXISTS idx_requisitions_head_chef_reviewed_by
  ON public.requisitions (head_chef_reviewed_by)
  WHERE head_chef_reviewed_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_requisitions_head_chef_queue
  ON public.requisitions (canteen_id, head_chef_status, created_at)
  WHERE status = 'pending' AND head_chef_required;
