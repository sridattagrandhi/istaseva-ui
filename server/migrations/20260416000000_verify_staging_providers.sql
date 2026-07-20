-- Staging only: mark all pending providers as verified for testing
UPDATE public.provider_profiles
SET verification_status = 'verified', verified_at = NOW()
WHERE verification_status = 'pending';
