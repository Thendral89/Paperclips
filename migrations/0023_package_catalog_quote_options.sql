-- Paperclip CRM: package catalog fidelity + customer-selectable quote package options
-- Additive migration. Preserves existing package/service/quote rows and backfills the
-- new structures from the current catalog.

CREATE TABLE IF NOT EXISTS package_details (
  package_id INTEGER PRIMARY KEY REFERENCES packages(id) ON DELETE CASCADE,
  sessions_text TEXT,
  crew_json TEXT NOT NULL DEFAULT '[]',
  deliverables_json TEXT NOT NULL DEFAULT '[]',
  complimentary_json TEXT NOT NULL DEFAULT '[]',
  source_note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quote_package_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL REFERENCES lead_quotes(id) ON DELETE CASCADE,
  package_id INTEGER NOT NULL REFERENCES packages(id),
  label TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  details_json TEXT,
  selected INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(quote_id, package_id)
);
CREATE INDEX IF NOT EXISTS idx_quote_package_options_quote
  ON quote_package_options(quote_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_quote_package_options_selected
  ON quote_package_options(quote_id, selected);

-- Services represented in the supplied package PDF. These are catalog entries
-- so package contents can be selected and reused by Quotes/Events. Prices are
-- intentionally 0 where the PDF did not provide an individual service price.
INSERT OR IGNORE INTO services(name,base_price,category,description,active)
VALUES
 ('Traditional Photographer',0,'Crew','Traditional photography crew member',1),
 ('Traditional Videographer',0,'Crew','Traditional videography crew member',1),
 ('Creative Photographer',0,'Crew','Creative photography crew member',1),
 ('Cinematographer',0,'Crew','Cinematic video crew member',1),
 ('Drone',0,'Additional Service','Drone coverage; package pricing is bundled',1),
 ('LED Wall (12*8)',0,'Additional Service','12×8 LED wall; package pricing is bundled',1),
 ('Mixing Unit',0,'Additional Service','Mixing unit included in Exclusive package',1);

-- Package contents from the supplied PDF. Existing package rows are retained;
-- these inserts only create missing package-item links.
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Traditional Photographer'
WHERE p.name='Basic';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Traditional Videographer'
WHERE p.name='Basic';

INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Traditional Photographer'
WHERE p.name='Standard';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Traditional Videographer'
WHERE p.name='Standard';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Creative Photographer'
WHERE p.name='Standard';

INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Traditional Photographer'
WHERE p.name='Classic';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Traditional Videographer'
WHERE p.name='Classic';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Creative Photographer'
WHERE p.name='Classic';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Cinematographer'
WHERE p.name='Classic';

INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Traditional Photographer'
WHERE p.name='Premium';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,2 FROM packages p JOIN services s ON s.name='Traditional Videographer'
WHERE p.name='Premium';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Creative Photographer'
WHERE p.name='Premium';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Cinematographer'
WHERE p.name='Premium';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Drone'
WHERE p.name='Premium';

INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,2 FROM packages p JOIN services s ON s.name='Traditional Photographer'
WHERE p.name='Exclusive';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,2 FROM packages p JOIN services s ON s.name='Traditional Videographer'
WHERE p.name='Exclusive';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Creative Photographer'
WHERE p.name='Exclusive';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Cinematographer'
WHERE p.name='Exclusive';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Drone'
WHERE p.name='Exclusive';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='LED Wall (12*8)'
WHERE p.name='Exclusive';
INSERT OR IGNORE INTO package_items(package_id,service_id,quantity)
SELECT p.id,s.id,1 FROM packages p JOIN services s ON s.name='Mixing Unit'
WHERE p.name='Exclusive';

-- Exact package detail snapshots derived from the supplied 10-page PDF.
INSERT OR REPLACE INTO package_details(package_id,sessions_text,crew_json,deliverables_json,complimentary_json,source_note)
SELECT p.id,'2 sessions',
'["Traditional Photographer × 1","Traditional Videographer × 1"]',
'["Exclusive picture highlights","Unlimited softcopy files","Album photo book × 1","80 pages; 200 edited pictures per album","Full HD Traditional video — Edited version","Full secured private video links"]',
'[]','Wedding Package Details PDF — Basic'
FROM packages p WHERE p.name='Basic';

INSERT OR REPLACE INTO package_details(package_id,sessions_text,crew_json,deliverables_json,complimentary_json,source_note)
SELECT p.id,'2 sessions',
'["Traditional Photographer × 1","Traditional Videographer × 1","Creative Photographer × 1"]',
'["Exclusive picture highlights","Unlimited softcopy files","Online software based photo selection — album","Album photo book × 1","80 pages; 200–250 edited pictures per album","Full HD Traditional video — Edited version","Full secured private video links"]',
'[]','Wedding Package Details PDF — Standard'
FROM packages p WHERE p.name='Standard';

INSERT OR REPLACE INTO package_details(package_id,sessions_text,crew_json,deliverables_json,complimentary_json,source_note)
SELECT p.id,'2 sessions',
'["Traditional Photographer × 1","Traditional Videographer × 1","Creative Photographer × 1","Cinematographer × 1"]',
'["Exclusive picture highlights","Unlimited softcopy files","Complete RAW images copied to hard drive","Online software based photo selection — album","Album photo book × 1","80 pages; 200–250 edited pictures per album","Glossy/Mate finish album","Full HD Traditional video — Edited version","Full secured private video links","Cinematic film (2 to 3 mins)"]',
'["Pre/post wedding photoshoot"]','Wedding Package Details PDF — Classic'
FROM packages p WHERE p.name='Classic';

INSERT OR REPLACE INTO package_details(package_id,sessions_text,crew_json,deliverables_json,complimentary_json,source_note)
SELECT p.id,'2 sessions',
'["Traditional Photographer × 1","Traditional Videographer × 2","Creative Photographer × 1","Cinematographer × 1","Drone × 1"]',
'["Exclusive picture highlights","Unlimited softcopy files","Complete RAW images copied to hard drive","Online software based photo selection — album","Album photo book × 2","80 pages; 200 edited pictures per album","Glossy/Mate finish album","Full HD Traditional video — Edited version","Full secured private video links","Cinematic film (2 to 3 mins)","Exclusive reel video"]',
'["Pre/post wedding photoshoot","Guest link — AI based photo sharing (complimentary)"]','Wedding Package Details PDF — Premium'
FROM packages p WHERE p.name='Premium';

INSERT OR REPLACE INTO package_details(package_id,sessions_text,crew_json,deliverables_json,complimentary_json,source_note)
SELECT p.id,'2 sessions',
'["Traditional Photographer × 2","Traditional Videographer × 2","Creative Photographer × 1","Cinematographer × 1","Drone × 1","LED Wall 12×8 × 1","Mixing Unit"]',
'["Exclusive picture highlights","Unlimited softcopy files","Complete RAW images copied to hard drive","Online software based photo selection — album","Premium Album photo book × 3","80 pages; 200 edited pictures per album","Glossy/Mate finish album","Full HD Traditional video — Edited version","Full secured private video links","Cinematic film (2 to 3 mins)","Exclusive reel video"]',
'["Pre/post wedding photoshoot","Pre/post wedding videoshoot","Guest link — AI based photo sharing"]','Wedding Package Details PDF — Exclusive'
FROM packages p WHERE p.name='Exclusive';

-- Backfill the new option model from existing package quote items.
INSERT OR IGNORE INTO quote_package_options(quote_id,package_id,label,price,details_json,selected,sort_order)
SELECT qi.quote_id,qi.package_id,qi.label,qi.price,
       json_object(
         'sessions',pd.sessions_text,
         'crew',json(pd.crew_json),
         'deliverables',json(pd.deliverables_json),
         'complimentary',json(pd.complimentary_json)
       ),
       CASE WHEN qi.selected=1 THEN 1 ELSE 0 END,
       qi.id
FROM quote_items qi
LEFT JOIN package_details pd ON pd.package_id=qi.package_id
WHERE qi.package_id IS NOT NULL AND qi.is_addon=0;

-- A quote has one customer-selectable package option. For legacy quotes where
-- several package rows were already selected, preserve the first selected row
-- as the option and leave the remaining historical quote rows untouched.
UPDATE quote_package_options
SET selected=0
WHERE selected=1
  AND id <> (
    SELECT MIN(q2.id)
    FROM quote_package_options q2
    WHERE q2.quote_id=quote_package_options.quote_id
      AND q2.selected=1
  );

CREATE INDEX IF NOT EXISTS idx_package_items_package
  ON package_items(package_id, service_id);
