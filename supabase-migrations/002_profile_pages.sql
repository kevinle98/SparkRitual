-- Public profile pages (?u=<display name>): every Unlisted and Public deck of an account set to Visible.
-- Run once in the Supabase SQL editor after 001_account_settings.sql.
-- (supabase-schema.sql already includes this for new projects.)

-- Returns null when the name doesn't exist or the account is Hidden, so the two cases look the same.
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
