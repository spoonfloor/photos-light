# Photos Light Share Viewer

Static viewer for shared photo albums. Deploy the contents of this folder to
[photos-light-sharing](https://github.com/spoonfloor/photos-light-sharing) for
GitHub Pages.

## URL format

`https://spoonfloor.github.io/photos-light-sharing/?s={slug}`

## Setup

1. Apply `../supabase/migrations/20260812140000_share_albums.sql` in Supabase.
2. Copy `js/config.js` values if your Supabase project differs.
3. Push this folder to the GitHub Pages repo.

## Local preview

```bash
cd share-viewer
python3 -m http.server 8080
```

Open `http://localhost:8080/?s=your-slug`.
