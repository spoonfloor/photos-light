# Share UI behavior parity matrix

Share must match app behavior unless listed in [share-ui-deltas.md](./share-ui-deltas.md).

| Behavior | Shared module | App + share |
|---|---|---|
| Month header hover circle | `SimplePhotoGrid` + CSS | both |
| Month select-all | `GridSelection.handleMonthCircleClick` | both |
| Shift range select | `GridSelection.toggleCard` | both |
| Select circle on tile | `GridTile.attachThumbLoadHandler` | both |
| Star toggle (no flash) | `GridTile.applyStarBadgeState` | both |
| Selection toggle (no flash) | `GridSelection.applyToDom` | both |
| Selected chip when count > 0 | `PhotoChrome.updateFilterChips` | both |
| Utilities menu position | `PhotoChrome.toggleUtilitiesMenu` | both |
| Grid click routing | `GridInteractions.wireContainer` | both |

CI: `test_share_viewer_build.py` + `test_grid_selection.py`
