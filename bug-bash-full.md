# Testing Checklist Photos Light

# 1 Library Management

Open existing library (custom folder picker) **[x] pass** [ ] fail

Notes: Hide Time Machine BU folders from list. Add rescan button. Investigate broken thumbnail icons (fixed by rebuilding database). Make last-used path sticky. Add keyboard shortcut for desktop (command-shift D).

Create new library with photos (select location → import) **[x] pass** [ ] fail

Notes: Photo picker is a bit sluggish. Verify duplicates on import from eric_files test library

Create new library from folder without db [ ] pass **[x] fail**

Notes: ‘Select this location’ should read ‘Open’ and should be disabled for folders without a db. Add ‘Create new’ that adds a blank db and navigates to empty library state

Switch between multiple libraries (Menu → Switch library) **[x] pass** [ ] fail

# 2 Grid View

View photos in thumbnail grid (400x400 squares, center-cropped) **[x] pass** [ ] fail

Lazy-load thumbnails on scroll (hash-based cache) [ ] pass **[x] fail**

Notes: in Opbfrwgeiu library, purging thumbnails cases broken images on media below the fold; rebuilding index restores images

Month divider headers (auto-group by YYYY-MM) **[x] pass** [ ] fail

Select single photo (click) **[x] pass** [ ] fail

Shift-select range (click first, shift+click last) **[x] pass** [ ] fail

Cancel selection (ESC key or click outside) **[x] pass** [ ] fail

Scroll performance with 1k+ photos **[x] pass** [x] fail

Month dividers update as you scroll [ ] pass **[x] fail**

Notes: Flashes of other dates appear on scroll

# 3 Delete & Recovery

Delete single photo (move to \`.trash/\`, remove from grid) **[x] pass** [ ] fail

Delete multiple photos (batch operation) **[x] pass** [ ] fail

Undo deletion (restore via toast notification) **[x] pass** [ ] fail

Auto-cleanup empty folders after delete **[x] pass** [ ] fail

Delete thumbnail cache entry **[x] pass** [ ] fail

Notes: Should also remove thumbnail folder

Toast shows for 8 seconds with undo option [ ] pass **[x] fail**

Notes: 8 seconds is not the value nor should it be; verify or create a central variable to elect a canonical value

# 4 Date Editing

## Single photo

Open date editor from grid (select photo → Edit date) **[x] pass** [ ] fail

Open date editor from lightbox ('e' key or Edit date link) **[x] pass** [ ] fail

Change date and time (date picker \+ time input) **[x] pass** [ ] fail

Notes: Date change causes navigation from lightbox to grid (bad)

Save changes (updates DB, re-sorts grid) **[x] pass** [ ] fail

## Multiple photos

Same date mode (all photos → same date/time) **[x] pass** [ ] fail

    Note: triggers resort

Offset mode (shift all by offset from first photo) **[x] pass** [ ] fail

Sequence mode seconds interval [] pass [ ] fail **[x] can’t assess**

    Notes: can’t assess in app bc lacks seconds display

Sequence mode minutes interval **[x] pass** [ ] fail

Sequence mode hours interval **[x] pass** [ ] fail

Maintains chronological order in offset mode **[x] pass** [ ] fail

Maintains chronological order in sequence mode **[x] pass** [ ] fail

Notes: Date change anchor date should be that of set’s topmost wrt grid

Maintains chronological order in same date mode [ ] pass [ ] fail **[x] n/a**

Notes: Changes photo order; b/x photos sorted by name once dates are identical? What is the desired UX?

## Edge Cases:

Invalid dates rejected [ ] pass **[x] fail**

Notes: It’s possible to select February 31st (bad)

Grid re-sorts after save **[x] pass** [ ] fail

# 5 Navigation & Sorting

## Controls

Sort by newest first (DESC by date_taken) **[x] pass** [ ] fail

Sort by oldest first (ASC by date_taken) **[x] pass** [ ] fail

Jump to specific month/year (date picker) [ ] pass **[x] fail**

Notes: same can year appear multiple times (bad)

Find nearest month (if target month has no photos) **[x] pass** [ ] fail

## Edge Cases:

Year-aware landing (prefers staying in target year) [ ] pass [ ] fail **[x] can’t test**

Notes: Don’t understand; need script to test

Directional landing based on sort order [ ] pass [ ] fail **[x] can’t test**

Notes: Don’t understand; need script to test

Date picker shows only years with photos [ ] pass **[x] fail**

Notes: see above; same can year appear multiple times (bad)

# 6 Import

## Import Flow

Menu → Add photos (opens custom photo picker) **[x] pass** [ ] fail

Browse filesystem (folders \+ files) **[x] pass** [ ] fail

See media counts in folders ("(243)" or "(many)") **[x] pass** [ ] fail

Multi-select files and folders **[x] pass** [ ] fail

Import with progress (SSE streaming) [ ] pass **[x] fail**

Notes: Import dupe counts don’t reflect reality (bad)

## Behind the Scenes:

Auto-dedupe by content hash (SHA-256) [ ] pass **[x] fail**

Notes: Import dupe counts don’t reflect reality (bad)

Extract EXIF date (fallback to file mtime) [ ] pass [ ] fail **[x] ???**

Notes: What does this mean?

Canonical naming: \`img_YYYYMMDD_hash.ext\` **[x] pass** [ ] fail

Organize by: \`YYYY/YYYY-MM-DD/filename\` **[x] pass** [ ] fail

Show counts: imported / duplicates / errors [ ] pass **[x] fail**

Notes: Import scoreboard count can bounce around non-sequentially (bad) (importing from test library on NAS)

# 7 Lightbox

## Basic Controls

Click photo in grid → open lightbox **[x] pass** [ ] fail

Navigate with arrow keys (← previous, → next) **[x] pass** [ ] fail

Close with ESC key **[x] pass** [ ] fail

Auto-hide UI controls (reappear on mouse move) **[x] pass** [ ] fail

Display date taken (clickable → jump to grid) **[x] pass** [ ] fail

Notes: Should frame grid so that date is visible

Display filename (clickable → reveal in Finder) **[x] pass** [ ] fail

## Advanced Features

Open date editor (Edit date button) **[x] pass** [ ] fail

Video playback (for .mov, .mp4, .m4v, etc.) **[x] pass** [ ] fail

Notes: full frame icon-> spacebar-> closes full frame (bad)

HEIC/HEIF conversion (auto-convert to JPEG) [ ] pass [ ] fail **[x] ???**

Notes: How would I test this?

TIF/TIFF conversion (auto-convert to JPEG) [ ] pass [ ] fail **[x] ???**

Notes: How would I test this?

Aspect ratio preservation (width or height constrained) [x] pass [ ] fail

## Edge Cases:

Very wide/tall images (maintain aspect ratio) **[x] pass** [ ] fail

Video thumbnail shows first frame **[x] pass** [ ] fail

Notes: First frame is bad UX when frame is black

# 8 Utilities Menu

## Clean Index (Update Library Index)

Need to verify these on the backend->

- Scan first (shows: ghosts, moles, empty folders) [ ] pass [ ] fail
- Execute cleanup (SSE progress streaming) [ ] pass [ ] fail
- Removes ghosts (in DB, not on disk) [ ] pass [ ] fail
- Adds moles (on disk, not in DB) [ ] pass [ ] fail

Removes empty folders **[x] pass** [ ] fail

## Remove Duplicates

Duplicates removed [ ] pass **[x] fail**

Notes: Created a dupe manually; but utility indicated zero dupes

Need to verify these on the backend->

- Find duplicate content hashes [ ] pass [ ] fail
- List all duplicate sets [ ] pass [ ] fail
- Show file count [ ] pass [ ] fail

## Rebuild Thumbnails

Need to verify these on the backend->

- Check count (GET /api/utilities/check-thumbnails) [ ] pass [ ] fail
- Clear cache (delete \`.thumbnails/\` directory) [ ] pass [ ] fail
- Confirm lazy regeneration on scroll [ ] pass [ ] fail

## Switch Library

Browse for library **[x] pass** [ ] fail

Health check on switch [ ] pass [ ] fail **[x] ???**

Notes: don’t know how to determine this

Handle migration prompts [ ] pass [ ] fail **[x] ???**

Notes: what does this mean?

# 9 Recovery & Rebuild

## Database Rebuild

Menu → Rebuild database (when DB missing/corrupt) **[x] pass** [ ] fail

Pre-scan library (shows file count) **[x] pass** [ ] fail

Estimate duration (displays: "X minutes" or "X hours") [ ] pass **[x] fail**

Notes: estimate missing

Warning for 1000+ files [ ] pass **[x] fail**

Notes: Error-> buttons.forEach is not a function

Execute rebuild (SSE progress: scan → hash → insert) [ ] pass [ ] fail **[x] ???**

Notes: how would i check?

Create new database if missing **[x] pass** [ ] fail

## Auto-Recovery (Tier 1\)

Auto-create missing \`.thumbnails/\` **[x] pass** [ ] fail

Auto-create missing \`.trash/\` **[x] pass** [ ] fail

Auto-create missing \`.db_backups/\` **[x] pass** [ ] fail

Auto-create missing \`.import_temp/\` **[x] pass** [ ] fail

Auto-create missing \`.logs/\` **[x] pass** [ ] fail

## Backups

Database auto-backup before destructive operations [ ] pass **[x] fail**

Notes: I see photo_library.db-journal; but nothing appears in db backup folder

Max 20 backups kept (oldest deleted) [ ] pass [ ] fail **[x] ???**

Notes: Nothing appearing in db backup folder

Timestamped filenames: \`photo_library_YYYYMMDD_HHMMSS.db\` [ ] pass [ ] fail **[x] ???**

Notes: Nothing appearing in db backup folder

# 10 Keyboard Shortcuts

ESC Close lightbox / close date editor / deselect all (priority order) **[x] pass** [ ] fail

Arrow Left Previous photo (lightbox only) **[x] pass** [ ] fail

Arrow Right Next photo (lightbox only) **[x] pass** [ ] fail

Priority Order for ESC: **[x] ???**

1 Close date editor (if open in lightbox)

2 Close lightbox (if open)

3 Deselect all photos (if on grid)

Notes: Selection should be cancelled on navigate to lightbox

# 11 File Format Support

## Photos

JPG, JPEG, HEIC, HEIF, PNG, GIF, BMP, TIFF, TIF **[x] pass** [ ] fail

## Videos

MOV, MP4, M4V, MPG, MPEG [ ] pass **[x] fail**

Notes: MPG/MPEG won’t play in lightbox

## Conversion

HEIC/HEIF → JPEG (on-the-fly, 95% quality) [ ] pass [ ] fail **[x] ???**

Notes: How to check?

TIF/TIFF → JPEG (on-the-fly, 95% quality) [ ] pass [ ] fail **[x] ???**

Notes: How to check?

Video thumbnails → JPEG (first frame, 400x400 center-crop) **[x] pass** [ ] fail

Notes: need a solution to avoid black frames

# 12 Error Handling & Edge Cases

Manual restore & rebuild [ ] pass **[x] fail**

Notes: Manually restore deleted photo so it sits at root level (no date folder)-> rebuild database-> photo reappears in grid (good)-> photo still at root level (bad)

## Library Issues

Library not found → first-run screen **[x] pass** [ ] fail

Database missing → prompt to rebuild [ ] pass **[x] fail**

Notes: no such prompt appears

Database corrupted → prompt to rebuild [ ] pass **[x] fail**

Notes: prompts to rebuild, but photos don’t appear on rebuild complete; dialog gives way to a blank page where grid should be

Need help testing these \>

## Import Issues

File not found → skip, increment error count [ ] pass [ ] fail

notes:

Duplicate detected → skip, increment duplicate count [ ] pass [ ] fail

notes:

Hash collision → rename with counter (\`\_1\`, \`\_2\`) [ ] pass [ ] fail

notes:

EXIF extraction fails → fallback to mtime [ ] pass [ ] fail

notes:

Dimension extraction fails → store as NULL [ ] pass [ ] fail

notes:

## Runtime Issues

Missing thumbnail → regenerate on request [ ] pass [ ] fail

notes:

File moved/deleted → show error in lightbox [ ] pass [ ] fail

notes:

# 13 Misc Notes

- Rebuild db has Done CTA (bad)
- Rebuild db scoreboard feels odd wrt total files (static) vs. indexed (dynamic)
- Inconsistent wording-> Update library index vs Rebuild database (bad)
- Date change toast has emoji (bad); scrub all dialogs of emoji
- Add seconds to the date display in lightbox info panel
- Date change should anchor on date of set’s topmost photo wrt grid
- Add spinner to picker, e.g., reading large dir on NAS
- Check super slow to appear in picker wrt NAS dirs (should check optimistically and then calculate file count)
- Import doesn’t scroll grid to imported photos (bad)
- Move ‘Set all to same date’ to bottom of the list of options
- Done button can appear slightly after rebuild done screen appears (bad)
- Import media can start-> return to confirm start import-> [Import]-> finish (bad) (importing from test library on NAS)
- Videos not labelled as videos in grid (bad)
- Open library picker CTA is Select this location (bad); should be Open or Create new
- Import media can say it’s found double the number of files (bad)
- Date change should rename files as needed and update db; rn date sequence-> 60 hour interval-> no change to folders (bad)
- What happens if there’s a collision in trash folder?
- Double check exts on USB-C drive
- Photos sometimes don’t fill lightbox (see example)
