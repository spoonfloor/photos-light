# Scroll target recipe (iron-clad test targets)

Give agents exact pass/fail targets without interpreting console numbers yourself.

## Your workflow

1. Open library at your normal window size (refined grid, not provisional).
2. Scroll to the first position that looks correct.
3. **Ctrl+Cmd+A** — copies checkpoint JSON to clipboard (data only, no labels).
4. Click **sort swap**.
5. Scroll to the next position.
6. **Ctrl+Cmd+A** again.
7. Repeat swap → scroll → copy as needed.
8. Paste each clipboard chunk to your agent (or save merged as `tools/fixtures/scroll_anchor_recipe.json`).

Each checkpoint is a scroll **position** readout only — no sort-toggle action is inferred (you scroll after swapping before copying).

## Clipboard payload (one checkpoint)

```json
{"setup":{"containerWidth":813,"columns":4,...},"expect":{"scrollTop":0,"sort":"newest","headMonth":"2099-01","anchorMonth":"2099-01","row":0,"rowViewportY":56},"frozenAnchor":{"kind":"date-then-row",...}}
```

## Interpretation rules (fixed — never renegotiated)

| Position              | scrollTop | rowViewportY | month / row / sort |
| --------------------- | --------- | ------------ | ------------------ |
| Top or bottom of page | exact     | exact        | exact              |
| Mid-scroll            | ±15 px    | ±5 px        | exact              |

## Console helpers (optional)

| Command                     | Purpose                           |
| --------------------------- | --------------------------------- |
| **Ctrl+Cmd+A**              | Copy current checkpoint (primary) |
| `copyScrollCheckpoint()`    | Same as shortcut                  |
| `copyScrollTargetRecipe()`  | Copy full merged recipe JSON      |
| `clearScrollTargetRecipe()` | Start over                        |
| `getScrollTargetRecipe()`   | Return merged recipe object       |

## Agent workflow

1. Merge pasted checkpoints → `tools/fixtures/scroll_anchor_recipe.json`
2. Run `./tools/run_scroll_anchor_evals.sh`
3. Claim done only when `user_scroll_target_recipe` passes

## Files

| File                                       | Role              |
| ------------------------------------------ | ----------------- |
| `static/js/gridScrollTargetRecipe.js`      | Keyboard recorder |
| `tools/fixtures/scroll_anchor_recipe.json` | Your targets      |
| `tools/eval_scroll_anchor_harness.js`      | Offline runner    |
