# Dialog Quick Reference

## When to Use Which Template

### Simple Dialog
**Use when:** User needs to confirm/cancel an action  
**Examples:** Delete photo, clear selection, confirm import  
**Buttons:** Cancel + Primary action

### Progress Dialog  
**Use when:** Operation takes time and shows updates  
**Examples:** Import, rebuild database, generate thumbnails  
**Features:** Spinner, stats, progress text

### Blocking Dialog
**Use when:** Critical error requiring immediate action  
**Examples:** Database missing, library not found  
**Features:** No close button, forces choice

## Visual Cheat Sheet

```
┌─────────────────────────────────────┐
│ Title                            [X]│ ← 16px/20px padding
├─────────────────────────────────────┤ ← border-color
│                                     │ ← 8px/20px padding  
│ Content goes here                   │ ← 14px text
│                                     │ ← 12px/20px padding
├─────────────────────────────────────┤ ← border-color
│                  [Cancel] [Primary] │ ← 16px/20px padding
└─────────────────────────────────────┘
     400px max width, 12px radius
```

## Copy-Paste Patterns

### Paragraph Spacing
```html
<p style="margin: 0 0 12px 0;">First paragraph</p>
<p style="margin: 0 0 12px 0;">Second paragraph</p>
<p style="margin: 0;">Last paragraph (no bottom margin)</p>
```

### Monospace Path
```html
<p style="font-family: monospace; font-size: 12px; color: var(--text-secondary); margin: 0 0 12px 0;">
  /path/to/file
</p>
```

### Button Pattern
```html
<button class="import-btn import-btn-secondary" id="cancelBtn">
  Cancel
</button>
<button class="import-btn import-btn-primary" id="confirmBtn">
  Confirm
</button>
```

## Reference Dialogs

### Simple Confirmation
**See:** Switch library overlay (`switchLibraryOverlay.html`)
- Clean, simple structure
- Two buttons: Cancel + Choose
- Current library path shown

### Progress Dialog
**See:** Import overlay (`importOverlay.html`) or Rebuild database (`rebuildDatabaseOverlay.html`)
- Real-time status updates
- Optional stats counters
- Expandable details section

### Blocking Error
**See:** Critical error modal (`criticalErrorModal.html`)
- No close button
- Forces user to make a choice
- Clear error messaging
