# Scroll anchor evals

Autonomous checks for sort-toggle scroll anchoring. Run these **before** asking for manual smoke approval on scroll-anchor changes.

**Recording iron-clad targets:** see [SCROLL_TARGET_RECIPE.md](./SCROLL_TARGET_RECIPE.md) — scroll → **Ctrl+Cmd+A** → swap → repeat → paste checkpoints to agent.

## Quick run

```bash
./tools/run_scroll_anchor_evals.sh
```

Or individually:

```bash
node tools/eval_scroll_anchor_harness.js          # human-readable
node tools/eval_scroll_anchor_harness.js --json   # machine-readable
python3 -m unittest test_scroll_anchor_eval.py -q
```

## What gets tested

### Offline harness (`tools/eval_scroll_anchor_harness.js`)

Loads `gridLayout.js` + `gridScrollAnchor.js` in Node (no browser). Uses a fixed 3-month fixture and mirrors `virtualGrid` restore helpers.

| Tier          | Meaning                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **required**  | Must pass. Exit 1 on failure.                                                                                                  |
| **guard**     | Passes while a known anti-pattern is still present. Fails when the pattern is removed — update the guard when landing the fix. |
| **known_bug** | Expected failure until fixed; does not fail the run (promote to required when fixed).                                          |

**Required cases (manual smoke mapping):**

| Eval id                                | Maps to                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `resolver_mid_scroll_freeze_row`       | Case 2 — mid-scroll must pick freeze-row                 |
| `resolver_catalog_head_date_then_row`  | Case 1 — catalog head picks date-then-row                |
| `mid_scroll_sort_no_catalog_head_jump` | Case 2 — animals cluster must not jump to catalog head   |
| `golden_case1_near_head_roundtrip`     | Case 1 — full roundtrip from `scroll_anchor_golden.json` |
| `golden_case2_mid_scroll_roundtrip`    | Case 2 — mid-scroll roundtrip from golden fixture        |

Golden fixture: `tools/fixtures/scroll_anchor_golden.json` + `scroll_anchor_month_index.json` (your library histogram). User recipe: `scroll_anchor_recipe.json` — toggle chain at 813×977 including top-to-bottom + Case 2 regression.

**Known bug (XFAIL until fixed, does not fail the run):**

| Eval id                                    | Maps to                                            |
| ------------------------------------------ | -------------------------------------------------- |
| `mid_scroll_freeze_fail_no_pixel_fallback` | FREEZE failure must not use pixel fallback on sort |

**Guard cases (fix scroll anchor → update or remove):**

| Eval id                                    | Documents                                                        |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `sort_toggle_pixel_fallback_enabled`       | `applyCatalogFilterWarm` passes `previousScrollTop` into restore |
| `pixel_fallback_distorts_viewport_on_sort` | Raw pixel restore changes visible month after reorder            |
| `queue_pending_ignores_resolved_row`       | `DATE_THEN_ROW` failure queues criteria-only async lookup        |

### Python (`test_scroll_anchor_eval.py`)

- Runs the Node harness as a subprocess (JSON summary, asserts `required_failed === 0`).
- Static contract checks on `gridScrollAnchor.js` / `virtualGrid.js` wiring.

## Agent workflow

1. Make scroll-anchor changes.
2. Run `./tools/run_scroll_anchor_evals.sh`.
3. If guards fail because you **fixed** the anti-pattern, update the guard eval in the harness.
4. Rebuild packaged app and run manual smoke (Cases 1 & 2) only after evals pass.

## Limits

- **No DOM, no hydration, no thumbnails** — layout math and restore policy only.
- Offline math can pass while packaged UI still fails (timing, mount state).
- Does not replace NAS manual smoke or `./packaging/build.sh` prod verification.

## References

- Grid architecture: `docs/GRID_OPTIMIZATION_ARCHITECTURE.md`
- Sort-toggle manual cases: see scroll-anchor task notes / chat context
