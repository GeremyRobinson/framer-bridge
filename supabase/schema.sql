-- Bridge: one row of settings per user, readable and writable only by them.
-- Run once in the Supabase SQL editor.

create table if not exists public.bridge_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.bridge_settings enable row level security;

drop policy if exists "Read own settings" on public.bridge_settings;
create policy "Read own settings" on public.bridge_settings
  for select using (auth.uid() = user_id);

drop policy if exists "Insert own settings" on public.bridge_settings;
create policy "Insert own settings" on public.bridge_settings
  for insert with check (auth.uid() = user_id);

drop policy if exists "Update own settings" on public.bridge_settings;
create policy "Update own settings" on public.bridge_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
