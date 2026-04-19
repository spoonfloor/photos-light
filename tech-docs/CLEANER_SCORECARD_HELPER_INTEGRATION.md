# Cleaner Scorecard Helper Integration

This doc is for an agent wiring the finished cleaner scorecard helper into product flows.

## Goal

Use one helper for all cleaner scoreboards:

- six fixed cleaner signals as truth
- any number of buckets
- arbitrary bucket labels
- countdown driven by real cleaner run-time burn-down
- no effect on cleaner behavior or order

## Source Of Truth

The helper is built on the six cleaner signals already produced by `make_library_perfect.py`:

- `misfiled_media`
- `unsupported_files`
- `duplicates`
- `metadata_cleanup`
- `folder_cleanup`
- `database_repairs`

Preflight truth comes from:

- `scan_library_cleanliness(...)`
- `result.operations.summary`
- `result.operations.details`

Run-time truth comes from:

- `run_db_normalization_engine(...)`
- streamed `signal_plan` and `signal_delta` events from `/api/library/make-perfect/stream`

## Helper API

The frontend helper lives on:

- `window.CleanerScorecardHelper`

It exposes:

- `SIGNAL_DEFS`
- `DEFAULT_VIEW`
- `normalizeSignalCounts(summary)`
- `normalizeView(view)`
- `reduceToBuckets(summary, view)`
- `applySignalDeltas(summary, deltas)`
- `createRuntime({ scorecard, signalCounts, view })`

## View Shape

A view can have any number of buckets.

Each bucket is:

```js
{
  key: 'trash_and_repairs',
  label: 'Trash + repairs',
  signals: ['unsupported_files', 'database_repairs']
}
```

Example six-column default:

```js
window.CleanerScorecardHelper.DEFAULT_VIEW
```

Example two-column custom view:

```js
[
  {
    key: 'trash',
    label: 'Trash',
    signals: ['unsupported_files', 'duplicates'],
  },
  {
    key: 'repair',
    label: 'Repair',
    signals: ['misfiled_media', 'metadata_cleanup', 'folder_cleanup', 'database_repairs'],
  },
]
```

## Runtime Shape

Create a normal scorecard UI first:

```js
const scorecard = createScorecardController({ statusEl, statsEl });
```

Then create helper runtime:

```js
const runtime = window.CleanerScorecardHelper.createRuntime({
  scorecard,
  view,
});
```

Apply preflight totals:

```js
await runtime.setSignalCounts(scanResult.operations.summary);
```

Apply streamed run-time events:

```js
await runtime.applyStreamEvent(event, {
  animate: event.type === 'signal_delta',
  duration: 200,
});
```

The runtime always recalculates bucket values from the current six-signal state.

If one signal drops by 9, every bucket containing that signal drops accordingly.

## Stream Event Contract

The cleaner stream now emits two helper-specific event types in addition to existing phase/progress events.

### `signal_plan`

Sent once near the start of the run.

Shape:

```js
{
  type: 'signal_plan',
  summary: {
    misfiled_media: 7,
    unsupported_files: 1,
    duplicates: 1,
    metadata_cleanup: 1,
    folder_cleanup: 4,
    database_repairs: 4,
    operation_count: 18,
  },
  details: {
    misfiled_media: [...],
    unsupported_files: [...],
    duplicates: [...],
    metadata_cleanup: [...],
    folder_cleanup: [...],
    database_repairs: [...],
  },
}
```

### `signal_delta`

Sent whenever real cleaner work clears planned signal items.

Shape:

```js
{
  type: 'signal_delta',
  deltas: {
    unsupported_files: 1,
    database_repairs: 3,
  },
  remaining: {
    misfiled_media: 1,
    unsupported_files: 0,
    duplicates: 0,
    metadata_cleanup: 0,
    folder_cleanup: 0,
    database_repairs: 1,
    operation_count: 2,
  },
  action: 'rebuild_db',
}
```

`remaining` is the authoritative post-update state.

## Current Product Status

### Already helper-backed

- the debug/sandbox cleaner scoreboard path in `static/js/main.js`

### Not yet helper-backed

- open-folder Basecamp-style rebuild progress in `openLibraryFromBrowseUnified(...)`
- clean-library / Update Database overlay in `openUpdateIndexOverlay(...)` and `executeUpdateIndex(...)`

## Open Folder Integration Plan

Target function:

- `openLibraryFromBrowseUnified(...)`

Current problem:

- it still uses `createLibraryRecoveryStatsCountdown(...)`
- that countdown is synthetic
- its current stats are recovery-media stats, not cleaner helper buckets

What to do:

1. Keep the existing dock shell (`libraryRecoveryDock.html` and `createScorecardController(...)` style rendering).
2. Remove `createLibraryRecoveryStatsCountdown(...)` from the rebuild path.
3. Before starting the streamed cleaner run, decide which helper view the dock should show.
4. Create a helper runtime for the dock stats area.
5. When `streamMakeLibraryPerfect(...)` yields:
   - on `signal_plan`: initialize the helper runtime
   - on `signal_delta`: animate the helper runtime
   - on `phase` / `progress`: keep using those only for status text like "Preparing library" / "Verifying library"
6. Do not derive countdown from `Added` / `Total` anymore if the goal is a true helper-backed scoreboard.

Recommended split:

- status text: phase labels
- scoreboard: helper buckets

## Cleaner Flow Integration Plan

Target functions:

- `openUpdateIndexOverlay(...)`
- `executeUpdateIndex(...)`

What to do:

### Scan step

1. Use `GET /api/library/make-perfect/scan`.
2. Read only:
   - `data.operations.summary`
   - `data.operations.details`
3. Create helper runtime with the chosen cleaner view.
4. Set initial helper totals from `data.operations.summary`.
5. If details are needed for a detail drawer, read them from `data.operations.details`, not from the old top-level issue summary.

### Run step

1. Stop using blocking `requestMakeLibraryPerfect()` for a scoreboard that must count down live.
2. Use `streamMakeLibraryPerfect(...)` instead.
3. Feed every `signal_plan` / `signal_delta` event into the helper runtime.
4. Keep existing phase text if desired, but do not use phase progress as bucket truth.

If the flow should stay blocking, you can still use the helper for preflight display, but not for animated truthful burn-down.

## Minimal Wiring Example

```js
const view = [
  { key: 'trash', label: 'Trash', signals: ['unsupported_files', 'duplicates'] },
  {
    key: 'repair',
    label: 'Repair',
    signals: ['misfiled_media', 'metadata_cleanup', 'folder_cleanup', 'database_repairs'],
  },
];

const scorecard = createScorecardController({ statusEl, statsEl });
const runtime = window.CleanerScorecardHelper.createRuntime({ scorecard, view });

const scanResponse = await fetch('/api/library/make-perfect/scan');
const scanResult = await scanResponse.json();
await runtime.setSignalCounts(scanResult.operations.summary);

await streamMakeLibraryPerfect({
  onProgress: async (event) => {
    if (event.type === 'signal_plan' || event.type === 'signal_delta') {
      await runtime.applyStreamEvent(event, {
        animate: event.type === 'signal_delta',
        duration: 200,
      });
      return;
    }

    if (event.type === 'phase') {
      statusEl.textContent = event.phase;
    }
  },
});
```

## Rules To Preserve

- Never compute helper totals from top-level `summary.issue_count` for product cleaner scoreboards.
- Never animate fake countdowns when a real helper-backed stream is available.
- Never let the helper change cleaner execution order.
- Treat `signal_plan` + `signal_delta` as helper truth during the run.
- Treat helper buckets as a view over the six signals, not as a second source of truth.

## Fast Checklist

- [ ] choose bucket view
- [ ] create `createScorecardController(...)`
- [ ] create `CleanerScorecardHelper.createRuntime(...)`
- [ ] initialize from `operations.summary`
- [ ] use `operations.details` for details UI
- [ ] stream `/api/library/make-perfect/stream`
- [ ] apply `signal_plan`
- [ ] apply `signal_delta`
- [ ] keep phase text separate from bucket values
- [ ] remove fake countdown logic from the target flow
