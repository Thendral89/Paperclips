-- Quote customization layer
-- Additive only. A package option is the commercial base; quote items snapshot the
-- package services so staff can customize this quote without changing the catalog.

ALTER TABLE quote_items ADD COLUMN quote_package_option_id INTEGER REFERENCES quote_package_options(id) ON DELETE CASCADE;
ALTER TABLE quote_items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_quote_items_package_option
  ON quote_items(quote_package_option_id, selected, id);

-- Attach legacy package line items to the corresponding quote option.
UPDATE quote_items
SET quote_package_option_id = (
  SELECT o.id FROM quote_package_options o
  WHERE o.quote_id = quote_items.quote_id
    AND o.package_id = quote_items.package_id
  ORDER BY o.id LIMIT 1
)
WHERE package_id IS NOT NULL AND is_addon = 0 AND quote_package_option_id IS NULL;

-- Every package option gets a quote-level service snapshot. The price starts at
-- zero because the package price already contains the bundled service. Staff can
-- enter a positive/negative adjustment on the quote line when customizing.
INSERT INTO quote_items
  (quote_id, service_id, package_id, quote_package_option_id, label, price, is_addon, selected, quantity)
SELECT o.quote_id, pi.service_id, o.package_id, o.id, s.name, 0, 0, 1, COALESCE(pi.quantity,1)
FROM quote_package_options o
JOIN package_items pi ON pi.package_id=o.package_id
JOIN services s ON s.id=pi.service_id
WHERE NOT EXISTS (
  SELECT 1 FROM quote_items qi
  WHERE qi.quote_package_option_id=o.id
    AND qi.service_id=pi.service_id
);

CREATE INDEX IF NOT EXISTS idx_quote_items_quote_option_service
  ON quote_items(quote_package_option_id, service_id);
