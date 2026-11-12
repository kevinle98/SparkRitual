-- Run this once in the Supabase SQL editor.

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null unique check (char_length(display_name) between 2 and 32),
  created_at   timestamptz not null default now()
);

create table public.decks (
  id          text primary key check (char_length(id) between 6 and 40),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  name        text not null default 'Untitled Deck' check (char_length(name) <= 80),
  description text not null default '' check (char_length(description) <= 5000),
  visibility  text not null default 'private' check (visibility in ('private', 'unlisted', 'public')),
  commanders  jsonb not null default '[]',
  cards       jsonb not null default '{}',
  sort        text not null default 'type',
  updated_at  timestamptz not null default now()
);
create index decks_owner_idx on public.decks (owner_id);

alter table public.profiles enable row level security;
alter table public.decks    enable row level security;

-- Profiles: display names are public; you can only edit your own.
create policy "profiles are readable"   on public.profiles for select using (true);
create policy "edit own profile"        on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- Decks: you manage your own; only PUBLIC decks are listable by others.
-- Unlisted decks are reachable only through get_deck() below, by exact id.
create policy "read own or public decks" on public.decks for select using (visibility = 'public' or owner_id = auth.uid());
create policy "insert own decks"         on public.decks for insert with check (owner_id = auth.uid());
create policy "update own decks"         on public.decks for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "delete own decks"         on public.decks for delete using (owner_id = auth.uid());

-- Fetch one deck by id if it is shared (unlisted/public) or yours.
create or replace function public.get_deck(p_id text)
returns json language sql security definer set search_path = public stable as $$
  select json_build_object(
    'id', d.id, 'name', d.name, 'description', d.description,
    'visibility', d.visibility, 'commanders', d.commanders, 'cards', d.cards, 'sort', d.sort,
    'owner', p.display_name, 'owner_id', d.owner_id, 'updated_at', d.updated_at)
  from public.decks d join public.profiles p on p.id = d.owner_id
  where d.id = p_id and (d.visibility <> 'private' or d.owner_id = auth.uid());
$$;
grant execute on function public.get_deck(text) to anon, authenticated;

-- Create a profile automatically on sign-up, with a unique display name.
-- Discord sign-ups use their Discord username; everyone else (email link, Google)
-- uses the part of the email before the @, so real names from Google are never published.
-- Safe to re-run on its own to update an existing project.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}');
  candidates text[] := array[]::text[];
  c text;
  base text := 'player';
  n text;
  i int := 0;
begin
  if new.raw_app_meta_data->>'provider' = 'discord' then
    candidates := array[meta->>'full_name', split_part(meta->>'name', '#', 1)];
  end if;
  candidates := candidates || split_part(coalesce(new.email, ''), '@', 1);
  foreach c in array candidates loop
    c := left(regexp_replace(coalesce(c, ''), '[^A-Za-z0-9_]', '', 'g'), 24);
    if char_length(c) >= 2 then base := c; exit; end if;
  end loop;
  n := base;
  while exists (select 1 from public.profiles where display_name = n) loop
    i := i + 1; n := base || i;
  end loop;
  insert into public.profiles (id, display_name) values (new.id, n);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
