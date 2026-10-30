-- Companion app support (run once on the Hub database, the same one that holds `orders` and `network_pharmacies`).
-- Safe to re-run: every statement is IF NOT EXISTS.

-- 1. Persisted offer / pick deadlines. The Hub used to keep these only in memory, so a restart left orders
--    stuck in SENT_TO_PHARMACY. The sweeper in companionRoutes.js advances any order whose deadline has passed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_deadline     timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS picking_started_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS extension_used     boolean NOT NULL DEFAULT false;

-- 2. Audit trail of what the chemist said he packed, and when (used for the dispute rules).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS packed_at    timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS packed_items jsonb;

CREATE INDEX IF NOT EXISTS orders_offer_deadline_idx ON orders (offer_deadline) WHERE status = 'SENT_TO_PHARMACY';

-- 3. Learned availability: items a pharmacy said it could not supply. Matching skips the pharmacy for these items
--    until blocked_until passes, the chemist presses "Restocked", or he packs an order containing the item.
CREATE TABLE IF NOT EXISTS pharmacy_item_blocks (
    pharmacy_id   uuid        NOT NULL REFERENCES network_pharmacies(id) ON DELETE CASCADE,
    item_key      text        NOT NULL,                 -- lower(trim(name)), the same key the matcher uses
    item_name     text        NOT NULL,
    reason        text        NOT NULL DEFAULT 'OUT_OF_STOCK',
    source        text        NOT NULL DEFAULT 'ORDER', -- ORDER (learned from a release) or MANUAL (virtual shelf toggle)
    order_id      uuid,
    blocked_until timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pharmacy_id, item_key)
);
CREATE INDEX IF NOT EXISTS pharmacy_item_blocks_active_idx ON pharmacy_item_blocks (item_key, blocked_until);

-- 4. Every time a chemist hands an order back, with the reason, so "lazy reject" and "out of stock" can be told apart.
CREATE TABLE IF NOT EXISTS order_release_log (
    id            bigserial PRIMARY KEY,
    order_id      uuid        NOT NULL,
    pharmacy_id   uuid        NOT NULL,
    reason        text        NOT NULL,                 -- OUT_OF_STOCK | BUSY | RX_INVALID | TIMEOUT
    missing_items jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_release_log_pharmacy_idx ON order_release_log (pharmacy_id, created_at DESC);
