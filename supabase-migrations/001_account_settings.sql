-- Account settings: account-wide deck visibility and case-insensitive unique display names.
-- Run once in the Supabase SQL editor on a project created from an older supabase-schema.sql.
-- (supabase-schema.sql already includes all of this for new projects.)

-- 1. Account visibility. When false, nobody else can open any of this user's decks,
--    whatever each deck's own visibility says.
alter table public.profiles add column if not exists decks_visible boolean not null default true;

-- 2. Display names are unique ignoring case ("Kevin" and "kevin" can't both exist).
--    Fails if two existing names already differ only by case; rename one first.
create unique index if not exists profiles_display_name_lower_idx on public.profiles (lower(display_name));

-- 3. Live availability check for the settings page. Your own current name counts as available.
create or replace function public.display_name_available(p_name text)
returns boolean language sql security definer set search_path = public stable as $$
  select not exists (
    select 1 from public.profiles
    where lower(display_name) = lower(p_name) and id is distinct from auth.uid()
  );
$$;
grant execute on function public.display_name_available(text) to authenticated;

-- 4. Respect account visibility when others read decks.
drop policy if exists "read own or public decks" on public.decks;
create policy "read own or public decks" on public.decks for select using (
  owner_id = auth.uid()
  or (visibility = 'public' and exists (select 1 from public.profiles p where p.id = owner_id and p.decks_visible))
);

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

-- 5. New sign-ups pick a name that is free ignoring case.
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
