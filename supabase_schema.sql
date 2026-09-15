-- Coach Fred — Supabase schema
-- Run this in the Supabase SQL editor to set up all required tables.

-- ============================================================
-- 1. USERS: tied to a Systeme.io purchase (via webhook on signup)
-- ============================================================
create table if not exists cf_users (
  id uuid primary key default gen_random_uuid(),
  systeme_customer_id text unique not null,   -- from Systeme.io webhook
  email text not null,
  country text,                                -- for anonymous aggregate reporting only
  monthly_message_cap int not null default 30, -- easily revisable per user or globally
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. USAGE LOG: per-message record, tied to a user, SHORT retention (90 days)
-- Deliberately does NOT store raw question/answer text — only metadata.
-- ============================================================
create table if not exists cf_usage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references cf_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  input_tokens int,
  output_tokens int,
  was_relevant boolean,        -- did the query fall inside book content, per the model's own flag
  topic_category text          -- coarse bucket only, e.g. "resilience", "money-basics" — not the raw question
);

-- Retention: delete usage log rows older than 90 days.
-- Schedule this via Supabase's pg_cron extension (see bottom of file).
-- delete from cf_usage_log where created_at < now() - interval '90 days';

-- ============================================================
-- 3. SAFEGUARD EVENTS: every time a cap, rate limit, or manual cutoff fires
-- Kept longer than usage logs (1 year) since this is the compliance/security evidence trail.
-- ============================================================
create table if not exists cf_safeguard_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references cf_users(id) on delete set null,
  created_at timestamptz not null default now(),
  event_type text not null,     -- 'monthly_cap_hit' | 'rate_limited' | 'manual_cutoff' | 'irrelevant_flagged'
  detail text
);

-- ============================================================
-- 4. MONTHLY AGGREGATES: fully anonymous, kept indefinitely
-- Built by a monthly scheduled job, never contains user_id.
-- ============================================================
create table if not exists cf_monthly_aggregates (
  id uuid primary key default gen_random_uuid(),
  month date not null,              -- first day of the month, e.g. 2026-09-01
  country text,
  topic_category text,
  question_count int not null default 0,
  unique (month, country, topic_category)
);

-- ============================================================
-- 5. SCHEDULED JOBS (pg_cron — enable the extension first in Supabase dashboard)
-- ============================================================

-- a) Daily: delete usage logs older than 90 days
-- select cron.schedule(
--   'cf_delete_old_usage_logs',
--   '0 3 * * *',  -- daily at 3am
--   $$ delete from cf_usage_log where created_at < now() - interval '90 days'; $$
-- );

-- b) Monthly: roll up last month's usage into cf_monthly_aggregates, anonymously
-- select cron.schedule(
--   'cf_monthly_rollup',
--   '0 4 1 * *',  -- 4am on the 1st of each month
--   $$
--     insert into cf_monthly_aggregates (month, country, topic_category, question_count)
--     select
--       date_trunc('month', now() - interval '1 month')::date,
--       u.country,
--       l.topic_category,
--       count(*)
--     from cf_usage_log l
--     join cf_users u on u.id = l.user_id
--     where l.created_at >= date_trunc('month', now() - interval '1 month')
--       and l.created_at < date_trunc('month', now())
--     group by u.country, l.topic_category
--     on conflict (month, country, topic_category)
--     do update set question_count = excluded.question_count;
--   $$
-- );

-- ============================================================
-- Handy admin queries (GDPR access/erasure requests)
-- ============================================================

-- What do we have on this user?
-- select * from cf_usage_log where user_id = '<uuid>';
-- select * from cf_safeguard_events where user_id = '<uuid>';

-- Delete everything tied to this user (erasure request):
-- delete from cf_usage_log where user_id = '<uuid>';
-- update cf_safeguard_events set user_id = null where user_id = '<uuid>';
-- delete from cf_users where id = '<uuid>';
