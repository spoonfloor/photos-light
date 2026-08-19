-- Secure share access: capability tokens, closed RLS, private storage bucket.
-- Option B transition: backfill access_token = slug for existing rows.

alter table public.albums
  add column if not exists access_token text,
  add column if not exists expires_at timestamptz,
  add column if not exists revoked_at timestamptz;

update public.albums
set access_token = slug
where access_token is null;

alter table public.albums
  alter column access_token set not null;

create unique index if not exists idx_albums_access_token on public.albums (access_token);

-- Revoke anon/authenticated read on catalog tables.
drop policy if exists "albums_public_read" on public.albums;
drop policy if exists "album_photos_public_read" on public.album_photos;

-- Private shares bucket; reads only via signed URLs from share-resolve.
update storage.buckets
set public = false
where id = 'shares';

drop policy if exists "shares_public_read" on storage.objects;
