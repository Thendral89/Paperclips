# Catalog mapping from the supplied PDF

Seeded package prices:
- Basic — ₹75,000
- Standard — ₹1,10,000
- Classic — ₹1,60,000
- Premium — ₹2,20,000
- Exclusive — ₹3,10,000

Additional services from page 10:
- Drone
- LED Wall (12*8)
- LED Wall (8*6)
- LED TV (55 inch)
- Live streaming
- 360 Degree photobooth
- Instant Photo printing

The migration intentionally uses 0 as the initial price for these additional services because the supplied PDF lists them without individual prices. Admin can set their actual price in the Services catalog.

The PDF also lists package crew and deliverables. The existing schema stores package price and included service references; it does not currently have a first-class package-deliverable table. Do not invent prices for individual deliverables that are not priced in the source.
