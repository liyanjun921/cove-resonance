-- Dedicated Work Events state. Apply only to a dedicated project.
create table if not exists public.work_event_subscriptions (
  id text primary key,
  name text not null check (name in ('general.message', 'work.wake')),
  arguments jsonb not null default '{}'::jsonb,
  url text not null,
  secret text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.work_event_deliveries (
  id text primary key,
  subscription_id text not null references public.work_event_subscriptions(id) on delete cascade,
  body jsonb not null,
  state text not null default 'pending' check (state in ('pending', 'processing', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists work_event_deliveries_due
  on public.work_event_deliveries (next_attempt_at, created_at)
  where state in ('pending', 'processing');

alter table public.work_event_subscriptions enable row level security;
alter table public.work_event_deliveries enable row level security;
revoke all on public.work_event_subscriptions, public.work_event_deliveries from anon, authenticated;

-- Claims are atomic even when ingress and cron dispatch overlap. A crashed
-- worker can reclaim after two minutes; event IDs stay stable for dedupe.
create or replace function public.claim_work_event_deliveries(batch_size integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  with chosen as (
    select d.id from public.work_event_deliveries d
    where (d.state = 'pending' and d.next_attempt_at <= now())
       or (d.state = 'processing' and d.next_attempt_at <= now())
    order by d.created_at asc limit least(greatest(batch_size, 1), 30)
    for update skip locked
  ), updated as (
    update public.work_event_deliveries d
    set state = 'processing', next_attempt_at = now() + interval '2 minutes'
    from chosen where d.id = chosen.id
    returning d.*
  )
  select coalesce(jsonb_agg(to_jsonb(d) || jsonb_build_object('subscription', to_jsonb(s))), '[]'::jsonb)
  into result from updated d
  join public.work_event_subscriptions s on s.id = d.subscription_id;
  return result;
end $$;

revoke all on function public.claim_work_event_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_work_event_deliveries(integer) to service_role;
