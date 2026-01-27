# Technical Documentation

This folder contains deep-dive technical documentation, implementation notes, and investigation reports.

## Contents

### EXIF/Metadata
- `EXIF_IMPORT_DEEP_DIVE.md` - Investigation of EXIF handling during import
- `EXIF_IMPORT_HOMEWORK.md` - Research notes on EXIF persistence
- `EXIF_IMPORT_IMPLEMENTATION.md` - Implementation details for EXIF writing
- `EXIF_IMPORT_VALIDATION.md` - Validation testing notes

### Hash Collision Investigations
- `HASH_COLLISION_FINDINGS.md` - Analysis of hash collision scenarios
- `HASH_COLLISION_INVESTIGATION.md` - Root cause investigation
- `HASH_COLLISION_ROOT_CAUSE.md` - Detailed diagnosis
- `IMPORT_DUPLICATE_HASH_COLLISION_INVESTIGATION.md` - Import-specific collision handling

### Date Editing
- `DATE_EDIT_BUG_SUMMARY.md` - Comprehensive investigation of date edit issues
- `AUTO_RELOAD_SCROLL.md` - Grid reload behavior investigation

### Folder/Photo Picker
- `FOLDER_PICKER_INTEGRATION.md` - Integration notes
- `FOLDER_PICKER_ISSUE_HANDOFF.md` - Bug handoff documentation
- `FOLDER_PICKER_RESOLUTION.md` - Resolution approach
- `PHOTO_PICKER_NAS_PERFORMANCE.md` - NAS performance analysis
- `PHOTO_PICKER_THUMBNAIL_FEASIBILITY.md` - Thumbnail implementation research
- `PICKER_PLACEHOLDER_VISUAL_ANALYSIS.md` - Empty state visual design
- `PICKER_THUMBNAILS_EXECUTIVE_REPORT.md` - Feature feasibility report
- `PLACEHOLDER_CSS_VERIFICATION.md` - CSS alignment verification

### Empty Folder Handling
- `EMPTY_FOLDER_CLEANUP_INVESTIGATION.md` - Cleanup behavior investigation
- `EMPTY_FOLDER_UX_DEEP_DIVE.md` - UX analysis for empty states

### Terraform (Library Conversion)
- `TERRAFORM_RESEARCH.md` - Feature research and planning
- `TERRAFORM_FAILURE_MODES.md` - Error scenario analysis
- `TERRAFORM_V189_TEST_PLAN.md` - v189 testing plan
- `TERRAFORM_IMPLEMENTATION_SPEC.md` - Implementation specification

### Picker Thumbnails
- `PICKER_THUMBNAILS_IMPLEMENTATION.md` - Implementation approach

### Recovery & Error Handling
- `RECOVERY_IMPLEMENTATION.md` - Auto-recovery feature implementation
- `PERMISSION_ERROR_HANDOFF.md` - Permission error investigation

### Library Flow
- `NEW_LIBRARY_FLOW.md` - New library creation flow design
- `FIRST_RUN_IMPROVEMENT.md` - First-run experience improvements

### Dialog System
- `DIALOG_CHECKLIST.md` - Dialog implementation checklist

## Purpose

These documents provide:
1. **Context** - Why certain implementation decisions were made
2. **Investigation trails** - How bugs were diagnosed
3. **Technical depth** - Implementation details beyond bug fix summaries
4. **Feasibility studies** - Research for feature planning

Refer to these when:
- Investigating similar issues
- Understanding implementation rationale
- Planning related features
- Debugging complex interactions

For bug status and fixes, see `bugs-fixed.md` and `bugs-to-be-fixed.md` in the root directory.
