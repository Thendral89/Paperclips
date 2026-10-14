-- Additive package detail support for quote engagement and correct default phase mapping.
ALTER TABLE package_details ADD COLUMN shared_content_url TEXT;

-- Correct only generated generic defaults; preserve explicit per-event mappings.
UPDATE service_work_mappings
SET work_group='Post-Production', phase='Post-Production'
WHERE event_type_key IS NULL AND work_group='Wedding' AND phase='Production'
  AND sort_order=50 AND active=1 AND service_id IN (
    SELECT id FROM services WHERE lower(COALESCE(category,'')) LIKE '%post%production%'
  );
UPDATE service_work_mappings
SET work_group='Pre-Production', phase='Pre-Production'
WHERE event_type_key IS NULL AND work_group='Wedding' AND phase='Production'
  AND sort_order=50 AND active=1 AND service_id IN (
    SELECT id FROM services WHERE lower(COALESCE(category,'')) LIKE '%pre%production%'
  );
