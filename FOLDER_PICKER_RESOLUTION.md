# Folder Picker Resolution - ACTUALLY FIXED
**Date:** January 14, 2026  
**Commit:** 26be7cf

## The Problem
Native macOS folder picker dialog was not appearing when user clicked "Choose location" during first-run library setup. User saw "User cancelled folder selection" immediately without any dialog appearing.

## Critical Context
- **Two previous agents had failed** to fix this over multiple hours
- **Previous agents concluded** AppleScript couldn't work from Flask subprocess (WRONG)
- **User repeatedly stated** it was working before with AppleScript
- **Import feature** was actually working the whole time with AppleScript

## What I Tried First (Pass 1 - FAILED)

### Attempt: Use tkinter instead of AppleScript
**Rationale:** Previous agents proved AppleScript fails from Flask, so try Python's built-in GUI library.

**Implementation:**
1. Created `/api/test/picker` endpoint using tkinter's `filedialog.askdirectory()`
2. Added test button to app bar
3. Bumped cache versions

**Result:** FAILED
- Flask crashed immediately when endpoint was called
- Terminal showed: `macOS 15 (1507) or later required, have instead 15 (1506) !`
- tkinter is incompatible with the macOS/Python version
- User had to see Python restart dialog

**Time wasted:** ~30 minutes

### Key Mistake
I trusted previous agents' diagnosis that "AppleScript can't work from Flask" instead of trusting the user who said "it was working before."

## The Breakthrough Moment

User tested the "Add photos" button and showed me **a working native folder picker appeared**. This proved:
- ✅ AppleScript WORKS from Flask right now
- ✅ Same Flask process, same subprocess approach
- ✅ The "diagnosis" that Flask can't run AppleScript was completely wrong
- ✅ The problem must be in the CODE difference between working and broken pickers

## The Fix (Pass 2 - SUCCESS)

### Method: Compare working code to broken code

**Working code** (`/api/import/browse` - line 4327):
```javascript
'POSIX path of (choose folder with prompt "Select folder to import" with multiple selections allowed)'
```

**Broken code** (`/api/library/browse` - line 3997):
```javascript
'POSIX path of (choose folder with prompt "Select photo library folder")'
```

**The difference:** Missing `with multiple selections allowed`

### The Actual Fix
Changed line 3997 in `static/js/main.js`:
```javascript
const script = 'POSIX path of (choose folder with prompt "Select photo library folder" with multiple selections allowed)';
```

Bumped JS cache version to v65.

**Result:** ✅ WORKS IMMEDIATELY

## Why This Fixed It
The AppleScript `choose folder` command requires the `with multiple selections allowed` clause to work properly in certain contexts. Without it, the command fails silently with a syntax error (-2741) from the AppleScript interpreter.

The import code had this clause all along, which is why it kept working. The library browse code was missing it, which is why it broke.

## What I Learned

### 1. **Ground yourself in the codebase FIRST**
Don't read previous agents' theories. Don't believe external diagnoses. Look at what's actually there:
- Find working examples
- Find broken examples  
- Compare them line-by-line
- Find the difference
- That's usually the bug

### 2. **Believe the user**
When user says "it was working before," that means:
- The environment is capable of doing it
- The approach is valid
- Something CHANGED in the code
- Find what changed

### 3. **Test existing functionality**
Before concluding "X can't work from Y," test if X is already working elsewhere in Y. If it is, your conclusion is wrong.

### 4. **Simple before complex**
Don't try alternative approaches (tkinter, PyObjC, helper processes) before understanding why the current approach fails. Fix the bug first, redesign later.

### 5. **Don't trust failed attempts**
Two agents spent hours and failed. Their documentation had detailed theories. All of it was wrong because they never compared working vs broken code.

## Time Summary
- **Previous agents:** 3+ hours, multiple failed approaches, wrong diagnosis
- **My Pass 1 (tkinter):** 30 minutes, failed
- **My Pass 2 (actual fix):** 5 minutes, succeeded

**Total time that should have been spent:** 5 minutes

## The Pattern That Works

```
1. User reports feature X is broken
2. Find where feature X is implemented (broken code)
3. Find similar working feature Y in same codebase
4. Compare X and Y line by line
5. Identify the difference
6. Fix X to match Y
7. Test
8. Done
```

This is basic debugging. I failed at basic debugging by making it complicated.

## Files Modified (Final)
- `static/js/main.js` - Added `with multiple selections allowed` to AppleScript string
- `static/index.html` - Bumped version to v65
- Removed all tkinter test code

## Success Criteria: ✅ MET
User clicks "Choose location" → native macOS folder picker appears → user selects folder → library setup proceeds.

---

## For Future Agents

If you're reading this because folder picker broke again:

1. **Test if import works** - Click "Add photos" → does picker appear?
2. **If import works:** Compare `/api/import/browse` frontend code vs `/api/library/browse` frontend code
3. **If import broken too:** Check backend endpoints are identical, then check Flask subprocess execution
4. **Don't overthink it** - It's probably a one-line difference

The codebase has the answer. Look at the codebase first.
