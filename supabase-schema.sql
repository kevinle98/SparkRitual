-- Run this once in the Supabase SQL editor.

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null unique check (char_length(display_name) between 2 and 32),
  decks_visible boolean not null default true, -- false: nobody else can open any of your decks
  created_at   timestamptz not null default now()
);

create unique index profiles_display_name_lower_idx on public.profiles (lower(display_name));

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
create policy "read own or public decks" on public.decks for select using (
  owner_id = auth.uid()
  or (visibility = 'public' and exists (select 1 from public.profiles p where p.id = owner_id and p.decks_visible))
);
create policy "insert own decks"         on public.decks for insert with check (owner_id = auth.uid());
create policy "update own decks"         on public.decks for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "delete own decks"         on public.decks for delete using (owner_id = auth.uid());

-- Fetch one deck by id if it is yours, or shared (unlisted/public) by an account that allows viewing.
create or replace function public.get_deck(p_id text)
returns json language sql security definer set search_path = public stable as $$
  select json_build_object(
    'id', d.id, 'name', d.name, 'description', d.description,
    'visibility', d.visibility, 'commanders', d.commanders, 'cards', d.cards, 'sort', d.sort,
    'owner', p.display_name, 'owner_id', d.owner_id, 'updated_at', d.updated_at)
  from public.decks d join public.profiles p on p.id = d.owner_id
  where d.id = p_id
    and (d.owner_id = auth.uid() or (d.visibility <> 'private' and p.decks_visible));
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
  while exists (select 1 from public.profiles where lower(display_name) = lower(n)) loop
    i := i + 1; n := base || i;
  end loop;
  insert into public.profiles (id, display_name) values (new.id, n);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Display-name availability check for the account settings page (ignores case; your own name counts as free).
create or replace function public.display_name_available(p_name text)
returns boolean language sql security definer set search_path = public stable as $$
  select not exists (
    select 1 from public.profiles
    where lower(display_name) = lower(p_name) and id is distinct from auth.uid()
  );
$$;
grant execute on function public.display_name_available(text) to authenticated;

-- Public profile page (?u=<display name>): every Unlisted and Public deck of a Visible account.
-- Returns null when the name does not exist or the account is Hidden, so the two cases look the same.
create or replace function public.get_profile_decks(p_name text)
returns json language sql security definer set search_path = public stable as $$
  select json_build_object(
    'owner', p.display_name,
    'owner_id', p.id,
    'decks', coalesce((
      select json_agg(json_build_object(
        'id', d.id, 'name', d.name, 'description', d.description, 'visibility', d.visibility,
        'commanders', d.commanders, 'cards', d.cards, 'sort', d.sort, 'updated_at', d.updated_at))
      from public.decks d
      where d.owner_id = p.id and d.visibility in ('unlisted', 'public')
    ), '[]'::json))
  from public.profiles p
  where lower(p.display_name) = lower(p_name) and p.decks_visible;
$$;
grant execute on function public.get_profile_decks(text) to anon, authenticated;
