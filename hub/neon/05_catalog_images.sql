-- Catalog photos (run once on the Hub database, the one with global_medicines). Safe to re-run.
-- A chemist photographs the strip/box in the companion app; the Hub stores the (already shrunk) image here and points
-- global_medicines.image_url at it. The customer app and the existing /api/catalog/* endpoints then show it with no further change.
ALTER TABLE global_medicines ADD COLUMN IF NOT EXISTS image_url text;

-- Image bytes live in their own table so ordinary SELECTs on the catalog never drag them along.
CREATE TABLE IF NOT EXISTS medicine_images (
    medicine_id  uuid PRIMARY KEY REFERENCES global_medicines(id) ON DELETE CASCADE,
    content_type text  NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    bytes        bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 153600),   -- 150 KB hard cap (the app sends ~30-60 KB)
    sha256       text  NOT NULL,
    uploaded_by  uuid,                                                             -- the pharmacy whose chemist verified and uploaded it
    uploaded_at  timestamptz NOT NULL DEFAULT now()
);
