-- Saved queries — per-user named filter presets (area, date window, cloud,
-- composite, optional compare settings) for the SavedQueriesPanel.
--
-- Storage model: only the server touches this table. RLS is ENABLED with NO
-- public policies — anon/authenticated/raw API access is denied outright —
-- and the app talks to it exclusively with the service-role key from
-- lib/server/supabase.ts (bypasses RLS; every statement still filters by
-- owner = session subject). The browser NEVER receives these credentials.
--
-- Setup (Supabase free tier): run this file in the SQL editor, then set
-- SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the deployment env.

create table if not exists public.saved_queries (
  id uuid primary key default gen_random_uuid(),
  owner text not null,
  name text not null,
  description text,
  area jsonb not null,
  date_range jsonb not null,
  max_cloud integer not null,
  composite text not null,
  compare jsonb,
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_at timestamptz,
  run_count integer not null default 0
);

-- One name per owner, case-insensitive — mirrors the API's NAME_TAKEN rule
-- (zod validation already caps max_cloud/composite, hence no CHECKs).
create unique index if not exists saved_queries_owner_name_key
  on public.saved_queries (owner, lower(name));

-- Default listing order: most recently updated first.
create index if not exists saved_queries_owner_updated_at_idx
  on public.saved_queries (owner, updated_at desc);

alter table public.saved_queries enable row level security;
