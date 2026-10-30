-- Fresh projects should use 002_schedule.sql's `with schema extensions`.
-- Only needed to repair a pre-existing pg_net installation in public.
drop extension pg_net;
create extension pg_net with schema extensions;
