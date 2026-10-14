-- Align the seeded catalog with the existing workflow and skill model.
-- Restrict changes to known seed entries; customer-created catalog rows remain untouched.

UPDATE services SET category='Production'
WHERE name IN (
  'Candid photography', 'Traditional photography', 'Cinematic video',
  'Drone coverage', 'Pre-wedding shoot', 'Traditional Photographer',
  'Traditional Videographer', 'Creative Photographer', 'Cinematographer', 'Drone'
);

UPDATE services SET category='Post-Production'
WHERE name IN (
  'Album — 30pg premium', 'Album — 40pg premium', 'Complete Album Work',
  'Album Layout', 'Album Printing Coordination', 'Social Media Edit',
  'Client Reference Pictures Upload'
);

-- Convert only the generic mappings previously inferred by the CRM; preserve
-- event-specific or operator-customized mappings.
UPDATE service_work_mappings SET work_group='Post-Wedding',phase='Post-Production'
WHERE event_type_key IS NULL AND work_group='Wedding' AND phase='Production'
  AND sort_order=50 AND active=1
  AND service_id IN (SELECT id FROM services WHERE name IN (
    'Album — 30pg premium','Album — 40pg premium','Complete Album Work',
    'Album Layout','Album Printing Coordination','Social Media Edit',
    'Client Reference Pictures Upload'
  ));

INSERT OR IGNORE INTO service_work_mappings(service_id,event_type_key,work_group,phase,auto_create,sort_order,active)
SELECT s.id,NULL,'Post-Wedding','Post-Production',1,50,1
FROM services s
WHERE s.category='Post-Production'
  AND NOT EXISTS (SELECT 1 FROM service_work_mappings m WHERE m.service_id=s.id AND m.active=1);

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='candid-photographer'
WHERE s.name IN ('Candid photography','Creative Photographer','Pre-wedding shoot');

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='traditional-photographer'
WHERE s.name IN ('Traditional photography','Traditional Photographer');

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='candid-videographer'
WHERE s.name IN ('Cinematic video','Cinematographer');

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='traditional-videographer'
WHERE s.name='Traditional Videographer';

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='drone-operator'
WHERE s.name IN ('Drone coverage','Drone');

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='complete-album-work'
WHERE s.name IN ('Album — 30pg premium','Album — 40pg premium','Complete Album Work');

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='album-layout-only'
WHERE s.name IN ('Album — 30pg premium','Album — 40pg premium','Album Layout');

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='album-printing-coordination'
WHERE s.name IN ('Album — 30pg premium','Album — 40pg premium','Album Printing Coordination');

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='social-media-edit'
WHERE s.name='Social Media Edit';

INSERT OR IGNORE INTO service_skills(service_id,skill_id)
SELECT s.id,k.id FROM services s JOIN skills k ON k.skill_key='client-reference-pictures-upload'
WHERE s.name='Client Reference Pictures Upload';
