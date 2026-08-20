-- Browser-display JPEG for share lightbox (full-res transcode; mirrors app /file tier)
alter table public.album_photos
  add column if not exists display_path text;
