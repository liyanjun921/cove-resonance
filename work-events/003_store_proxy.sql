-- A single high-entropy bridge token authenticates the Edge Function proxy.
-- Store only its SHA-256 digest; the clear token lives only in Render env.
create table if not exists public.work_event_bridge_auth (
  digest text primary key check (digest ~ '^[0-9a-f]{64}$'),
  label text not null,
  created_at timestamptz not null default now()
);
alter table public.work_event_bridge_auth enable row level security;
revoke all on public.work_event_bridge_auth from anon, authenticated;
