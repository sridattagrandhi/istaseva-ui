-- Denormalize Firebase email into user_profiles so the notification email
-- service can resolve a recipient address by DB UUID without a Firebase
-- Admin round-trip. Email is populated on every authenticated request via
-- the require-auth middleware.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS email VARCHAR(320);

CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles (email);
