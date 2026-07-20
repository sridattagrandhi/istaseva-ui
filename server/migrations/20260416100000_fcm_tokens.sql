-- FCM push tokens — one row per user/device pair.
-- A single user can have multiple devices (phone + laptop + tablet).
-- Tokens are upserted on login and deleted when the user logs out or
-- the token becomes invalid (FCM returns UNREGISTERED).

CREATE TABLE IF NOT EXISTS public.fcm_tokens (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     TEXT         NOT NULL,
  token       TEXT         NOT NULL,
  platform    TEXT         NOT NULL DEFAULT 'web',   -- web | android | ios
  device_hint TEXT,                                   -- user-agent snippet, for debugging
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT fcm_tokens_user_token_unique UNIQUE (user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user_id ON public.fcm_tokens (user_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_fcm_token_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fcm_tokens_updated_at ON public.fcm_tokens;
CREATE TRIGGER trg_fcm_tokens_updated_at
  BEFORE UPDATE ON public.fcm_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_fcm_token_updated_at();
