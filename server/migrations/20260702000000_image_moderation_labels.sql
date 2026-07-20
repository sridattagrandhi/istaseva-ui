-- Per-image moderation labels: one row for every listing image that passed
-- through the NSFW gate (allowed OR rejected), with the model's verdict and
-- raw detection scores. This is the training corpus for future model
-- iterations — do not prune casually.
--
-- Rows where verdict != 'allow' reference images whose bytes were NOT
-- persisted (the upload was rejected before storage), so storage_key for
-- those is the key the upload *would* have had.

CREATE TABLE IF NOT EXISTS image_moderation_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL,
  storage_key text NOT NULL,
  user_id text,
  verdict text NOT NULL CHECK (verdict IN ('allow', 'review', 'block')),
  reasons text[] NOT NULL DEFAULT '{}',
  nsfw_score numeric,
  suggestive_score numeric,
  detections jsonb,
  model text,
  category text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Training/audit queries: "all rejected images this month", "allow-rate over time".
CREATE INDEX IF NOT EXISTS idx_image_moderation_labels_verdict_created
  ON image_moderation_labels (verdict, created_at DESC);

-- Look up the label for a stored image.
CREATE INDEX IF NOT EXISTS idx_image_moderation_labels_key
  ON image_moderation_labels (bucket, storage_key);
