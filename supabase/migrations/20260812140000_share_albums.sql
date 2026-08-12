-- Share albums catalog (published snapshot; not a full library DB)
-- Apply via Supabase Dashboard SQL editor or: supabase db push

create table if not exists public.albums (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text,
  photo_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.album_photos (
  id uuid primary key default gen_random_uuid(),
  album_id uuid not null references public.albums(id) on delete cascade,
  position integer not null,
  date_taken timestamptz,
  file_type text not null default 'photo',
  width integer,
  height integer,
  rating integer,
  thumb_path text not null,
  original_path text not null,
  original_filename text,
  unique (album_id, position)
);

create index if not exists idx_album_photos_album_id on public.album_photos(album_id);
create index if not exists idx_album_photos_album_date
  on public.album_photos(album_id, date_taken desc nulls last);
create index if not exists idx_albums_slug on public.albums(slug);

alter table public.albums enable row level security;
alter table public.album_photos enable row level security;

drop policy if exists "albums_public_read" on public.albums;
create policy "albums_public_read" on public.albums
  for select to anon, authenticated using (true);

drop policy if exists "album_photos_public_read" on public.album_photos;
create policy "album_photos_public_read" on public.album_photos
  for select to anon, authenticated using (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'shares', 'shares', true, 524288000,
  array[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm',
    'application/zip'
  ]
)
on conflict (id) do update set public = excluded.public;

drop policy if exists "shares_public_read" on storage.objects;
create policy "shares_public_read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'shares');
