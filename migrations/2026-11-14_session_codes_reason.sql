-- CPT / HCPCS codes come from the session note (Kieran, Oct 2026): the
-- provider sets them on the note and they lock at the provider's signature.
-- The office can still re-code a signed session in EI-Hub claims, but only
-- with a reason, kept here with who / when. Additive only; safe to run again.
ALTER TABLE "EiSessionCodes" ADD COLUMN IF NOT EXISTS recode_reason TEXT;
