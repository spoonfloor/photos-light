# Terraform vs Rebuild Database - They Are NOT The Same!

**Date:** January 29, 2026  
**Status:** CRITICAL CORRECTION to previous analysis

---

## 🚨 **I WAS WRONG - THEY ARE DIFFERENT OPERATIONS**

### **What I Assumed:**

> "Terraform and Rebuild Database are essentially the same operation"

### **What They Actually Are:**

## 📊 **REBUILD DATABASE:**

**Purpose:** Index files that are ALREADY in correct structure

**What it does:**

```python
1. Backup old DB
2. Delete old DB
3. Create fresh DB
4. Call synchronize_library_generator(mode='full')
   - Scan all files
   - Hash each file
   - Extract EXIF
   - Get dimensions
   - INSERT into DB
5. Done
```

**Assumptions:**

- ✅ Files are already in YYYY/YYYY-MM-DD/ structure
- ✅ Files are already renamed to canonical format
- ✅ Files already have EXIF written
- ✅ No duplicates (or don't care)
- ✅ No orientation issues
- **Just rebuild the index!**

**Duration (your library):** ~6.8 hours (read-only scanning)

---

## 🔄 **TERRAFORM:**

**Purpose:** TRANSFORM files from chaotic mess into app-compliant structure

**What it does:**

```python
1. PRE-FLIGHT CHECKS
   - Check exiftool/ffmpeg installed
   - Check disk space (need 10% free)
   - Check write permissions

2. SCAN
   - Find all files
   - Separate media vs non-media
   - Move non-media to .trash/

3. CREATE DB (temp, not touching existing)

4. PROCESS EACH FILE (THIS IS THE BIG ONE):
   a. Hash file
   b. Check for duplicates → .trash/duplicates/
   c. Extract EXIF date
   d. Get dimensions
   e. **BAKE ORIENTATION** (pixel rotation when lossless)
      - Rotate actual pixels (jpegtran for JPEG)
      - Re-hash after rotation
      - Check for duplicates AGAIN
   f. **WRITE EXIF** (in place, to original file)
      - Write DateTimeOriginal
      - If fails → .trash/errors/
   g. **REHASH** (file changed after EXIF write)
   h. Check for duplicates AGAIN (hash changed)
   i. **MOVE FILE** to YYYY/YYYY-MM-DD/ structure
   j. **RENAME** to canonical format
   k. INSERT into DB

5. CLEANUP
   - Remove empty folders
   - Remove non-canonical folders

6. Final DB has ONLY successfully processed files
```

**Assumptions:**

- ❌ Files are in random structure
- ❌ Files have random names
- ❌ Files may lack EXIF
- ❌ Files may have orientation flags
- ❌ May have duplicates
- **Transform into compliant library!**

**Duration (your library):** ??? (MUCH longer - writes to every file!)

---

## 📊 **KEY DIFFERENCES:**

| Aspect              | Rebuild DB        | Terraform                            |
| ------------------- | ----------------- | ------------------------------------ |
| **Modifies files?** | ❌ No (read-only) | ✅ YES (writes EXIF, rotates pixels) |
| **Moves files?**    | ❌ No (in place)  | ✅ YES (reorganizes structure)       |
| **Renames files?**  | ❌ No             | ✅ YES (canonical naming)            |
| **Duration**        | 6.8 hours         | 20-40+ hours (!!!)                   |
| **Risk**            | Low (read-only)   | HIGH (modifies everything)           |
| **Duplicates**      | Allows            | Moves to trash                       |
| **Non-media**       | Ignores           | Moves to trash                       |
| **Orientation**     | Ignores           | Bakes into pixels                    |
| **Resume needed?**  | YES (7 hours)     | CRITICAL (20-40 hours!)              |

---

## ⏱️ **TERRAFORM TIMING ESTIMATE (Your 64K Library):**

### Operations PER FILE:

```
Hash #1:              0.217s
EXIF extract:         0.082s
Dimensions:           0.079s
Bake orientation:     0.500s (estimated - jpegtran subprocess)
Write EXIF:           0.150s (estimated - exiftool subprocess)
Hash #2 (after EXIF): 0.217s
Move file:            0.050s (NAS network)
Rename file:          0.020s
DB insert:            0.005s
─────────────────────────────
Total per file:       ~1.32 seconds
```

### Full Terraform:

```
64,357 files × 1.32s = 84,951 seconds = 23.6 hours
```

**If interrupted at 50% (hour 12):**

- Without checkpoint: Restart = 23.6 hours total
- With checkpoint: Resume = 11.8 hours remaining
- **Resume saves: 11.8 HOURS** (!!!)

---

## 💡 **REVISED UNDERSTANDING:**

### **Terraform IS NOT Rebuild Database**

They serve different purposes:

**Use Rebuild Database when:**

- Library is already terraform'd (compliant structure)
- Just need to rebuild the index
- DB is corrupted/lost
- Want to add new schema columns
- **Example:** My library after terraform, just rebuild index

**Use Terraform when:**

- Library is a mess (imports from phone, camera, old Photos.app, etc.)
- Files in random folders
- Files have random names
- Need to fix orientation issues
- Want canonical structure
- **Example:** My library BEFORE first terraform

---

## 🎯 **IMPLICATIONS FOR RESUME:**

### **Rebuild Database:**

- Duration: 6.8 hours
- Resume saves: 2.3 hours
- **Verdict:** Checkpoints helpful but not critical

### **Terraform:**

- Duration: 23.6 hours (!!)
- Resume saves: 11.8 hours (!!!)
- **Verdict:** Checkpoints ABSOLUTELY CRITICAL

**Over 24 hours, interruption is GUARANTEED, not just likely.**

---

## 🚨 **DOES THIS CHANGE THE PLAN?**

### **Previous Plan:**

- Clean Library: No checkpoints (fast)
- Terraform/Rebuild: Checkpoints (treated as same)

### **Revised Plan:**

| Operation     | Duration | Checkpoint?     | Priority        |
| ------------- | -------- | --------------- | --------------- |
| Clean Library | 4 min    | ❌ NO           | Common case     |
| Rebuild DB    | 6.8 hr   | ⚠️ NICE TO HAVE | Occasional      |
| Terraform     | 23.6 hr  | ✅ CRITICAL     | One-time (rare) |

---

## 📝 **NEW QUESTIONS:**

1. **When was terraform last run?**
   - If your library is already terraform'd, you may never run it again
   - Terraform is typically a ONE-TIME operation
   - After that, only Rebuild/Clean needed

2. **Is your library already terraform'd?**
   - Structure: Does /Volumes/eric_files/photo_library have YYYY/YYYY-MM-DD/ folders? YES (I see 1900, 1950, 1969, etc.)
   - Files: Are they named canonically? (checking...)

3. **Do you actually need to run Terraform again?**
   - Or just Rebuild Database?

---

## 🔍 **LET ME CHECK YOUR LIBRARY:**

Looking at your library structure, I see year folders (1900, 1950, etc.). This suggests it's ALREADY been terraform'd!

**If true:** You don't need Terraform checkpoints, you need Rebuild checkpoints.

**Question:** When did you last run Terraform? Was it the initial setup, or do you run it regularly?

---

**This changes my recommendation. Need to understand:**

- Is your library already terraform'd?
- Will you ever run Terraform again?
- Or is Rebuild Database your main long operation?
