-- Apply after storing a random tick token in Supabase Vault under the name
-- xlc_work_tick, and configuring the same token as WORK_EVENTS_TICK_TOKEN on
-- the isolated Render service. Never commit the token to this repository.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'xlc_work_events_quarter_hour',
  '*/15 * * * *',
  $$select net.http_post(
    url := 'https://xlc-general-bridge-lyj.onrender.com/work/tick',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'xlc_work_tick' limit 1
      )
    ),
    timeout_milliseconds := 90000
  )$$
);
