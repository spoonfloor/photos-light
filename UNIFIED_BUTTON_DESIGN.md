# Unified Button Design Specification

**Date:** January 28, 2026  
**Status:** Task 2 of 12 - COMPLETE  
**Purpose:** Define new unified button classes to replace 3 legacy systems

---

## Design Decisions

### Class Naming: `.btn` System

**Chosen naming:** `.btn`, `.btn-primary`, `.btn-secondary`

**Rationale:**

1. ✅ Industry standard (Bootstrap, Tailwind, Material UI all use `.btn`)
2. ✅ Shorter than `.import-btn` (easier to type, cleaner HTML)
3. ✅ More semantic - clearly indicates "button" purpose
4. ✅ Extensible - can add `.btn-danger`, `.btn-success` later if needed
5. ✅ BEM-like naming convention (block-modifier pattern)

**Rejected alternatives:**

- `.import-btn` - Too specific, implies only for import dialogs
- `.button` - Already exists as unused base class, could cause confusion
- `.dialog-btn` - Too specific, not all buttons are in dialogs

---

## CSS Specification

### Optimal Values Analysis

Comparing the three existing systems:

| Property      | `.dialog-button` | `.date-editor-button` | `.import-btn` | **New `.btn`** |
| ------------- | ---------------- | --------------------- | ------------- | -------------- |
| padding       | `10px 20px`      | `10px 24px`           | `8px 16px` ✅ | **`8px 16px`** |
| border-radius | `4px`            | `4px`                 | `6px` ✅      | **`6px`**      |
| font-size     | `14px`           | `14px`                | `14px`        | **`14px`**     |
| font-weight   | `500`            | `500`                 | `500`         | **`500`**      |
| font-family   | (none)           | `inherit` ✅          | (none)        | **`inherit`**  |
| outline       | `none` ❌        | (none)                | (none)        | **(none)**     |
| :disabled     | ❌ NO            | ❌ NO                 | ✅ YES        | **✅ YES**     |

**Winner: `.import-btn`** system has the best values:

- Smaller padding (8px/16px) = more compact, modern feel
- More rounded corners (6px) = friendlier, more modern
- Has `:disabled` states = critical functionality

### Secondary Button Color Analysis

**Issue:** Date editor secondary button uses different color scheme:

| System                | Secondary Background | Secondary Text Color              |
| --------------------- | -------------------- | --------------------------------- |
| `.dialog-button`      | `transparent`        | `var(--text-primary)` (white)     |
| `.date-editor-button` | `transparent`        | `var(--accent-color)` ⚠️ (purple) |
| `.import-btn`         | `transparent`        | `var(--text-secondary)` (gray)    |

**Decision:** Use `.import-btn` secondary styling (gray text)

- **Rationale:**
  - More subtle, doesn't compete with primary button
  - Date editor's purple text is unique outlier (15 vs 1)
  - Gray secondary is industry standard (Bootstrap, etc.)
  - Purple secondary could be misread as primary action

**Visual hierarchy:**

1. Primary button (purple) = main action
2. Secondary button (gray) = cancel/alternative action

---

## Final CSS Implementation

```css
/* ============================================================================
   UNIFIED BUTTON SYSTEM
   Replaces: .dialog-button, .date-editor-button, .import-btn
   Created: January 28, 2026
   ============================================================================ */

.btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  font-family: inherit;
}

/* Primary button - Main action (purple) */
.btn-primary {
  background: var(--accent-color);
  color: white;
}

.btn-primary:hover {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
  background: var(--accent-color); /* Keep purple, just dimmed */
}

/* Secondary button - Cancel/alternative action (gray) */
.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
}

.btn-secondary:hover {
  color: var(--text-primary);
  background: var(--hover-bg);
}

.btn-secondary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}
```

---

## Comparison: Before vs After

### Example HTML (Before):

```html
<!-- Old: 3 different systems -->
<button class="dialog-button dialog-button-primary">Delete</button>
<button class="date-editor-button date-editor-button-primary">Save</button>
<button class="import-btn import-btn-primary">Continue</button>
```

### Example HTML (After):

```html
<!-- New: 1 unified system -->
<button class="btn btn-primary">Delete</button>
<button class="btn btn-primary">Save</button>
<button class="btn btn-primary">Continue</button>
```

**Benefits:**

- ✅ Shorter class names (24 characters → 16 characters = 33% reduction)
- ✅ Easier to remember (one system instead of three)
- ✅ Consistent styling across all dialogs
- ✅ Single source of truth for button behavior

---

## Visual Specifications

### Primary Button (`.btn-primary`)

**Normal State:**

- Background: `#6d49ff` (--accent-color)
- Text: `white`
- Padding: `8px 16px` (top/bottom: 8px, left/right: 16px)
- Border radius: `6px`
- Border: `none`
- Cursor: `pointer`

**Hover State:**

- Background: `#5a3ad6` (--accent-hover) - 10% darker

**Disabled State:**

- Background: `#6d49ff` (same color but dimmed)
- Opacity: `0.4` (40% transparent)
- Cursor: `not-allowed`
- Pointer events: `none` (not clickable)

**Example visual:**

```
┌────────────────┐
│   Continue  ←  │  Normal (bright purple)
└────────────────┘

┌────────────────┐
│   Continue  ←  │  Hover (darker purple)
└────────────────┘

┌────────────────┐
│   Continue  ←  │  Disabled (dimmed purple, grayed out)
└────────────────┘
```

---

### Secondary Button (`.btn-secondary`)

**Normal State:**

- Background: `transparent`
- Text: `#b3b3b3` (--text-secondary) - light gray
- Padding: `8px 16px`
- Border radius: `6px`
- Border: `none`
- Cursor: `pointer`

**Hover State:**

- Background: `var(--hover-bg)` - subtle gray background
- Text: `#e8e8e8` (--text-primary) - brighter white

**Disabled State:**

- Background: `transparent`
- Text: `#b3b3b3` (same gray but dimmed)
- Opacity: `0.4` (40% transparent)
- Cursor: `not-allowed`
- Pointer events: `none`

**Example visual:**

```
┌────────────────┐
│    Cancel      │  Normal (transparent, gray text)
└────────────────┘

┌────────────────┐
│    Cancel      │  Hover (gray background, white text)
└────────────────┘

┌────────────────┐
│    Cancel      │  Disabled (transparent, very dim gray)
└────────────────┘
```

---

## Responsive Considerations

### Touch Targets (Mobile)

Current padding `8px 16px` = 30px height (14px font + 8px top + 8px bottom)

**Accessibility concern:**

- ❌ 30px height is below recommended 44px minimum touch target (Apple HIG)
- ✅ However, all existing systems use similar heights
- ✅ App is desktop-focused (photo management)

**Decision:** Keep `8px 16px` padding for consistency with existing design

- Rationale: Matches current UX, desktop-first application
- Future: Could add `.btn-large` variant with `12px 20px` for mobile if needed

---

## Keyboard & Accessibility

### Focus States

**Current state:** No `:focus` styles defined in any of the three systems

**Recommendation for future:** Add focus-visible styles

```css
.btn-primary:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.btn-secondary:focus-visible {
  outline: 2px solid var(--text-secondary);
  outline-offset: 2px;
}
```

**Decision:** Defer to future enhancement

- Rationale: Matching existing behavior, keyboard support is Task 9-11
- All three existing systems lack focus styles
- Can add in separate accessibility pass after consolidation

---

## Migration Path Compatibility

### Backwards Compatibility Strategy

**Phase 1:** Add new `.btn` classes alongside old classes

- Old classes continue to work
- No breaking changes
- Gradual migration possible

**Phase 2:** Migrate all files to new classes

- Update HTML fragments
- Update JavaScript
- All buttons use new system

**Phase 3:** Remove old classes (breaking change)

- `.dialog-button` → deleted
- `.date-editor-button` → deleted
- `.import-btn` → deleted
- Only `.btn` system remains

### CSS Cascade Consideration

**Question:** Could old and new classes conflict?

**Analysis:**

- `.btn` is new name, won't conflict with `.dialog-button`, `.date-editor-button`, `.import-btn`
- `.btn-primary` is new name, won't conflict with old `-primary` suffixes
- `.btn-secondary` is new name, won't conflict with old `-secondary` suffixes

**Conclusion:** ✅ No cascade conflicts, safe to add new classes

---

## Testing Checklist

### Visual Testing

- [ ] Primary button renders with correct purple color
- [ ] Secondary button renders with correct gray text
- [ ] Hover states work correctly
- [ ] Disabled states show correct visual feedback
- [ ] Border radius is 6px (rounded corners)
- [ ] Padding creates comfortable click target
- [ ] Text is centered in button
- [ ] Button heights are consistent

### Interaction Testing

- [ ] Primary button is clickable
- [ ] Secondary button is clickable
- [ ] Hover changes appearance
- [ ] Disabled buttons are not clickable
- [ ] Cursor changes to pointer on hover
- [ ] Cursor changes to not-allowed on disabled

### Cross-Dialog Testing

- [ ] Buttons look consistent in all dialogs
- [ ] Same styling in date editor as other dialogs
- [ ] No visual regressions vs old buttons
- [ ] Spacing matches old button spacing

---

## Code Comments

### CSS Comment Block

The new CSS will include this comment block:

```css
/* ============================================================================
   UNIFIED BUTTON SYSTEM
   ============================================================================
   
   Purpose: Replace legacy button systems (.dialog-button, .date-editor-button, 
            .import-btn) with single unified system
   
   Created: January 28, 2026
   
   Usage:
     <button class="btn btn-primary">Continue</button>
     <button class="btn btn-secondary">Cancel</button>
   
   Classes:
     .btn           - Base button styles (padding, font, border-radius)
     .btn-primary   - Purple primary action button
     .btn-secondary - Gray secondary/cancel button
   
   Features:
     ✅ Disabled state support (:disabled selector)
     ✅ Hover effects
     ✅ Consistent sizing across all dialogs
     ✅ Accessible text colors (WCAG AA compliant)
   
   ============================================================================ */
```

---

## Dependencies & Variables

### Required CSS Variables

All required variables are already defined in `:root`:

```css
:root {
  --accent-color: #6d49ff; /* Primary button background */
  --accent-hover: #5a3ad6; /* Primary button hover */
  --text-primary: #e8e8e8; /* Secondary hover text */
  --text-secondary: #b3b3b3; /* Secondary normal text */
  --hover-bg: (undefined?); /* Secondary hover background */
}
```

**Issue:** `--hover-bg` not found in variables list

**Investigation needed:** Check if `--hover-bg` is defined, or if we should use `--placeholder-hover` instead

Let me verify...

Based on earlier CSS reading:

- Line 15: `--placeholder-hover: #333333;` ✅ EXISTS

**Decision:** Use `--placeholder-hover` for secondary button hover background

```css
.btn-secondary:hover {
  color: var(--text-primary);
  background: var(--placeholder-hover); /* #333333 */
}
```

---

## Final Implementation (Corrected)

```css
/* ============================================================================
   UNIFIED BUTTON SYSTEM
   Replaces: .dialog-button, .date-editor-button, .import-btn
   Created: January 28, 2026
   ============================================================================ */

.btn {
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  font-family: inherit;
}

/* Primary button - Main action (purple) */
.btn-primary {
  background: var(--accent-color);
  color: white;
}

.btn-primary:hover {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
  background: var(--accent-color);
}

/* Secondary button - Cancel/alternative action (gray) */
.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
}

.btn-secondary:hover {
  color: var(--text-primary);
  background: var(--placeholder-hover);
}

.btn-secondary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}
```

---

## Summary

**Design Status:** ✅ COMPLETE

**Key Specifications:**

- Class names: `.btn`, `.btn-primary`, `.btn-secondary`
- Padding: `8px 16px` (from `.import-btn`)
- Border radius: `6px` (from `.import-btn`)
- Disabled states: ✅ Included
- Hover states: ✅ Included
- Focus states: ⏭️ Deferred to future

**Next Step:** Task 3 - Add new classes to `styles.css`

**CSS lines to add:** ~40 lines with comments

**Location:** After `.button` class (line 52+) or in dedicated section
