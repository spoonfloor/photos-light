# Dialog Implementation Checklist

## 🚫 STOP - Read This BEFORE Writing Any Code

### Step 1: Choose Your Template
Which dialog type do you need?
- **Simple confirmation** → Copy `static/fragments/_template-simple-dialog.html`
- **Progress/streaming** → Copy `static/fragments/_template-progress-dialog.html`  
- **Blocking error** → Copy `static/fragments/_template-blocking-dialog.html`

### Step 2: Open Reference
Open the matching reference dialog in browser:
- Simple → "Switch library" dialog
- Progress → "Import" or "Rebuild database" dialog
- Blocking → "Database missing" error modal

Keep it open side-by-side while you build.

### Step 3: Visual Specs (Non-Negotiable)
- **Border radius:** 12px
- **Card width:** 400px max
- **Title:** 16px, weight 500
- **Body text:** 14px
- **Header padding:** 16px 20px 12px 20px
- **Content padding:** 8px 20px 12px 20px
- **Actions padding:** 16px 20px
- **Button gap:** 12px
- **Border color:** var(--border-color)

### Step 4: Structure Rules
✅ Order MUST be:
1. `.import-header` (title + optional close button)
2. `.import-progress-section` (all content)
3. `.import-actions` (buttons)

✅ Content flow:
- All text in `.import-status-text`
- Paragraphs use `<p>` tags
- Spacing: `margin: 0 0 12px 0`
- Last paragraph: `margin: 0`

✅ Content ordering (UX principle):
- **Context FIRST, action SECOND**
- Show current state/what they're looking at
- THEN explain what they can do
- Example: "Current library: /path" → "Choose a different folder"
- Users need WHERE THEY ARE before WHAT TO DO

✅ Button order:
- Secondary buttons LEFT
- Primary button RIGHT
- Classes: `.import-btn` + `.import-btn-secondary` or `.import-btn-primary`

### Step 5: Pre-Show Checklist
Before showing Eric, verify:
- [ ] Tested in browser (not just code review)
- [ ] Compared visually to reference dialog
- [ ] Title size matches (16px)
- [ ] Padding matches reference
- [ ] Buttons in correct order
- [ ] No custom inline styles (except approved cases)
- [ ] Content flows top-to-bottom naturally
- [ ] All interactive states work (hover, click, etc.)

### Step 6: Common Mistakes to Avoid
❌ Don't use `.dialog` classes (old system)
❌ Don't add custom padding/margins
❌ Don't skip the side-by-side visual check
❌ Don't guess - measure against reference
❌ Don't use `<br>` - use `<p>` tags
❌ Don't put primary button first

## Red Flags
If you find yourself:
- Writing custom CSS for this dialog
- Using inline styles for layout
- Thinking "this looks close enough"
- Not opening it in the browser

→ STOP. Re-read this checklist.
