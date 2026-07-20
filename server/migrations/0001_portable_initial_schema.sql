CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booking_status') THEN
    CREATE TYPE public.booking_status AS ENUM ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'expired');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
    CREATE TYPE public.payment_status AS ENUM ('pending', 'completed', 'failed', 'refunded');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'User',
  avatar_url TEXT,
  bio TEXT,
  phone TEXT,
  location TEXT,
  preferred_language TEXT DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.provider_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  service_categories TEXT[] NOT NULL DEFAULT '{}',
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  service_radius_km DOUBLE PRECISION NOT NULL DEFAULT 15,
  buffer_minutes INTEGER NOT NULL DEFAULT 30,
  is_available BOOLEAN NOT NULL DEFAULT true,
  bio TEXT,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.provider_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES public.provider_profiles(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_id, day_of_week, start_time)
);

CREATE TABLE IF NOT EXISTS public.listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  category TEXT,
  name TEXT,
  title TEXT,
  description TEXT,
  location TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  address TEXT,
  service_area TEXT,
  price TEXT,
  price_per_night NUMERIC,
  availability TEXT,
  photos TEXT[] DEFAULT '{}',
  images TEXT[] DEFAULT '{}',
  image_url TEXT,
  amenities TEXT[] DEFAULT '{}',
  vehicle_name TEXT,
  vehicle_year TEXT,
  property_type TEXT,
  max_guests INTEGER,
  bedrooms INTEGER,
  bathrooms INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT,
  is_published BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider_id UUID NOT NULL REFERENCES public.provider_profiles(id),
  service_category TEXT NOT NULL,
  scheduled_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  address TEXT,
  status public.booking_status NOT NULL DEFAULT 'pending',
  estimated_travel_minutes INTEGER DEFAULT 0,
  notes TEXT,
  hold_expires_at TIMESTAMPTZ,
  idempotency_key TEXT,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.slot_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES public.provider_profiles(id) ON DELETE CASCADE,
  scheduled_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  locked_by UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  status TEXT NOT NULL DEFAULT 'active',
  booking_id UUID REFERENCES public.bookings(id) ON DELETE CASCADE,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status public.payment_status NOT NULL DEFAULT 'pending',
  provider_ref TEXT,
  provider_payment_id TEXT,
  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  failed_reason TEXT,
  completed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.insurance_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  premium_amount NUMERIC NOT NULL DEFAULT 2,
  coverage_amount NUMERIC NOT NULL DEFAULT 500,
  coverage_type TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.insurance_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES public.insurance_policies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  claim_amount NUMERIC NOT NULL,
  description TEXT NOT NULL,
  evidence_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolution TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  stay_id TEXT NOT NULL,
  provider_id UUID,
  booking_id UUID,
  rating INTEGER NOT NULL,
  review_text TEXT,
  comment TEXT,
  title TEXT,
  tags TEXT[] DEFAULT '{}'::text[],
  photos TEXT[] DEFAULT '{}'::text[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT 'Anonymous',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reviews_rating_check CHECK (rating >= 1 AND rating <= 5)
);

CREATE TABLE IF NOT EXISTS public.verification_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES public.provider_profiles(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  document_number TEXT,
  file_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.service_guarantees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  provider_id UUID NOT NULL REFERENCES public.provider_profiles(id),
  service_category TEXT NOT NULL,
  guarantee_months INTEGER NOT NULL DEFAULT 3,
  guarantee_label TEXT NOT NULL DEFAULT '3-Month Guarantee',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  claim_description TEXT,
  claim_status TEXT DEFAULT 'none',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL,
  receiver_id UUID NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  type TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT false,
  link TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS images TEXT[] DEFAULT '{}';
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS amenities TEXT[] DEFAULT '{}';
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS property_type TEXT;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS price_per_night NUMERIC;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS max_guests INTEGER;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS bedrooms INTEGER;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS bathrooms INTEGER;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS provider_id UUID;
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS booking_id UUID;
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS photos TEXT[] DEFAULT '{}'::text[];
ALTER TABLE public.reviews ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.provider_profiles ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE public.provider_profiles ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON public.user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_provider_profiles_user_id ON public.provider_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_provider_profiles_categories ON public.provider_profiles USING GIN (service_categories);
CREATE INDEX IF NOT EXISTS idx_provider_availability_provider_day ON public.provider_availability(provider_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_listings_user_id ON public.listings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_provider_date ON public.bookings(provider_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON public.bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_stay_id ON public.reviews(stay_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON public.reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_verification_documents_provider_id ON public.verification_documents(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages(sender_id, receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON public.messages(receiver_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slot_locks_lookup ON public.slot_locks(provider_id, scheduled_date, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_slot_locks_expiry ON public.slot_locks(expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot_unique
  ON public.bookings (provider_id, scheduled_date, start_time, end_time)
  WHERE status IN ('pending', 'confirmed', 'in_progress');

CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_locks_active_slot_unique
  ON public.slot_locks (provider_id, scheduled_date, start_time, end_time)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_locks_active_user_provider_unique
  ON public.slot_locks (locked_by, provider_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_active_booking_unique
  ON public.payments (booking_id)
  WHERE status IN ('pending', 'completed');

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency_key_unique
  ON public.payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_idempotency_key_unique
  ON public.bookings (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_guarantees_booking_unique
  ON public.service_guarantees (booking_id);

DROP TRIGGER IF EXISTS update_user_profiles_updated_at ON public.user_profiles;
CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_provider_profiles_updated_at ON public.provider_profiles;
CREATE TRIGGER update_provider_profiles_updated_at
  BEFORE UPDATE ON public.provider_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_listings_updated_at ON public.listings;
CREATE TRIGGER update_listings_updated_at
  BEFORE UPDATE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_bookings_updated_at ON public.bookings;
CREATE TRIGGER update_bookings_updated_at
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_payments_updated_at ON public.payments;
CREATE TRIGGER update_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_insurance_policies_updated_at ON public.insurance_policies;
CREATE TRIGGER update_insurance_policies_updated_at
  BEFORE UPDATE ON public.insurance_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_insurance_claims_updated_at ON public.insurance_claims;
CREATE TRIGGER update_insurance_claims_updated_at
  BEFORE UPDATE ON public.insurance_claims
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_reviews_updated_at ON public.reviews;
CREATE TRIGGER update_reviews_updated_at
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_verification_documents_updated_at ON public.verification_documents;
CREATE TRIGGER update_verification_documents_updated_at
  BEFORE UPDATE ON public.verification_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_service_guarantees_updated_at ON public.service_guarantees;
CREATE TRIGGER update_service_guarantees_updated_at
  BEFORE UPDATE ON public.service_guarantees
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_messages_updated_at ON public.messages;
CREATE TRIGGER update_messages_updated_at
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.enforce_booking_state_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  has_completed_payment BOOLEAN;
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status NOT IN ('confirmed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'Invalid booking transition from % to %', OLD.status, NEW.status;
  END IF;

  IF OLD.status = 'confirmed' AND NEW.status NOT IN ('in_progress', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid booking transition from % to %', OLD.status, NEW.status;
  END IF;

  IF OLD.status = 'in_progress' AND NEW.status NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid booking transition from % to %', OLD.status, NEW.status;
  END IF;

  IF OLD.status IN ('completed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'Booking transition from terminal state % is not allowed', OLD.status;
  END IF;

  IF NEW.status = 'confirmed' THEN
    SELECT EXISTS(
      SELECT 1 FROM public.payments
      WHERE booking_id = NEW.id AND status = 'completed'
    ) INTO has_completed_payment;

    IF NOT has_completed_payment THEN
      RAISE EXCEPTION 'Confirmed bookings require a completed payment';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_booking_state_transition_trigger ON public.bookings;
CREATE TRIGGER enforce_booking_state_transition_trigger
  BEFORE UPDATE OF status ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_booking_state_transition();

CREATE OR REPLACE FUNCTION public.cleanup_expired_booking_holds()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  expired_lock_count INTEGER := 0;
  expired_booking_count INTEGER := 0;
BEGIN
  UPDATE public.slot_locks
  SET status = 'expired',
      released_at = NOW()
  WHERE status = 'active'
    AND expires_at <= NOW();

  GET DIAGNOSTICS expired_lock_count = ROW_COUNT;

  UPDATE public.bookings
  SET status = 'expired',
      expired_at = NOW(),
      updated_at = NOW()
  WHERE status = 'pending'
    AND hold_expires_at IS NOT NULL
    AND hold_expires_at <= NOW();

  GET DIAGNOSTICS expired_booking_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'expired_locks', expired_lock_count,
    'expired_bookings', expired_booking_count
  );
END;
$$;
