-- Tuna Tastan standalone migration S2 - initial schema.
-- Scope: only the domain actually observed in the real app's UI during the
-- S1 authenticated-session capture (2026-09-22) - see STANDALONE_MIGRATION_S1
-- report and PS-138/PS-139. Nothing here is invented beyond that:
--   - lists: the 4 sidebar entries (Work/Personal/Finance/General), modeled
--     as real user-owned rows (not hardcoded) so the existing `.add-list`
--     affordance in the captured CSS has somewhere to write to later.
--   - tasks: title, list, priority (a binary badge, not a level - that's
--     all that was ever visibly rendered), done, and a due_date - the due
--     date was NOT visible on a task row, but the "Task Calendar" widget's
--     entire purpose (month browsing, today/selected day) implies tasks are
--     associated with a day; everything else (notes, description, subtasks,
--     the real edit-modal's full field set) was never observed and is
--     deliberately left out rather than guessed - see PS-139 notes.
--   - user_settings: a single opaque jsonb blob, since no settings screen
--     was ever observed - avoids fabricating structured fields.
-- Run this once in the Supabase SQL editor (or via `supabase db push` if the
-- user later adopts the CLI - not required for this migration to apply).

create extension if not exists "pgcrypto";

create table if not exists public.lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null default 'coral' check (color in ('coral','violet','blue','gold')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  list_id uuid references public.lists(id) on delete set null,
  title text not null check (char_length(trim(title)) > 0),
  priority boolean not null default false,
  done boolean not null default false,
  due_date date,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists tasks_user_id_idx on public.tasks(user_id) where deleted_at is null;
create index if not exists tasks_list_id_idx on public.tasks(list_id) where deleted_at is null;
create index if not exists lists_user_id_idx on public.lists(user_id) where deleted_at is null;

-- updated_at auto-touch (keeps last-write-wins/revision logic honest even
-- if a client forgets to set it).
create or replace function public.tuna_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if TG_TABLE_NAME = 'tasks' then
    new.revision = coalesce(old.revision, 0) + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists tuna_touch_lists on public.lists;
create trigger tuna_touch_lists before update on public.lists
  for each row execute function public.tuna_touch_updated_at();

drop trigger if exists tuna_touch_tasks on public.tasks;
create trigger tuna_touch_tasks before update on public.tasks
  for each row execute function public.tuna_touch_updated_at();

drop trigger if exists tuna_touch_settings on public.user_settings;
create trigger tuna_touch_settings before update on public.user_settings
  for each row execute function public.tuna_touch_updated_at();

-- ---------------------------------------------------------------------
-- Row Level Security - mandatory, ownership enforced in the database, not
-- trusted to the client. Every policy checks auth.uid() = user_id on the
-- row being read/written, including on INSERT (via WITH CHECK), so a
-- request cannot create a row owned by someone else.
-- ---------------------------------------------------------------------
alter table public.lists enable row level security;
alter table public.tasks enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists lists_select_own on public.lists;
create policy lists_select_own on public.lists for select
  using (auth.uid() = user_id);
drop policy if exists lists_insert_own on public.lists;
create policy lists_insert_own on public.lists for insert
  with check (auth.uid() = user_id);
drop policy if exists lists_update_own on public.lists;
create policy lists_update_own on public.lists for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists lists_delete_own on public.lists;
create policy lists_delete_own on public.lists for delete
  using (auth.uid() = user_id);

drop policy if exists tasks_select_own on public.tasks;
create policy tasks_select_own on public.tasks for select
  using (auth.uid() = user_id);
drop policy if exists tasks_insert_own on public.tasks;
create policy tasks_insert_own on public.tasks for insert
  with check (auth.uid() = user_id);
drop policy if exists tasks_update_own on public.tasks;
create policy tasks_update_own on public.tasks for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists tasks_delete_own on public.tasks;
create policy tasks_delete_own on public.tasks for delete
  using (auth.uid() = user_id);

drop policy if exists settings_select_own on public.user_settings;
create policy settings_select_own on public.user_settings for select
  using (auth.uid() = user_id);
drop policy if exists settings_insert_own on public.user_settings;
create policy settings_insert_own on public.user_settings for insert
  with check (auth.uid() = user_id);
drop policy if exists settings_update_own on public.user_settings;
create policy settings_update_own on public.user_settings for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Seed the 4 observed default lists for a newly-enrolled user. Called from
-- the client once, right after first sign-in (see dataAdapter.js
-- ensureDefaultLists()) - not a DB trigger, so it stays a plain, auditable
-- insert the RLS policies above already cover; no elevated privileges used.

-- ---------------------------------------------------------------------
-- Realtime (found live 2026-09-22, PS-150): enabling RLS is NOT enough for
-- dataAdapter.js's postgres_changes subscriptions to receive anything - a
-- table must also be an explicit member of the `supabase_realtime`
-- publication, a separate opt-in Supabase requires per table. Without this,
-- the client-side channel still reports SUBSCRIBED/joined (misleadingly
-- looking healthy) while no INSERT/UPDATE/DELETE event ever arrives.
-- `alter publication ... add table` is NOT idempotent on its own (it
-- errors if the table is already a member), so this is guarded to stay
-- safe on every re-run of this migration. REPLICA IDENTITY is left at its
-- default (primary key) - the DELETE handler in dataAdapter.js only reads
-- payload.old.id, so the default's minimal old-row is already sufficient
-- and REPLICA IDENTITY FULL is not needed.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lists'
  ) then
    alter publication supabase_realtime add table public.lists;
  end if;
end $$;
