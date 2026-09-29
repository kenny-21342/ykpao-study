-- A guided tour for genuinely new students, and only for them.
--
-- `tourCompletedAt` is null for a user who has not finished (or dismissed) the
-- walkthrough that follows onboarding. The shell reads it as "show the tour",
-- which is the right default for an account created from now on.
--
-- It is the wrong default for accounts that already exist: every one of them
-- has been using the platform for weeks, and a plain `ADD COLUMN` would put a
-- tour of features they already know in front of all of them on their next
-- visit. So the same grandfathering the email-verification migration used
-- applies here -- stamp everyone who exists at this moment as done.
--
-- Stamping rather than gating on a hard-coded cutoff date keeps the runtime
-- check a plain `tourCompletedAt IS NULL`, with no constant to drift out of
-- step if the deploy slips. From this point the only way to get a non-null
-- value is to finish or dismiss the tour.
ALTER TABLE "users" ADD COLUMN "tourCompletedAt" TIMESTAMP(3);

UPDATE "users" SET "tourCompletedAt" = NOW() WHERE "tourCompletedAt" IS NULL;
