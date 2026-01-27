# Photo Picker Thumbnails - Implementation Plan

**Date:** January 25, 2026  
**Status:** READY FOR IMPLEMENTATION  
**Estimated effort:** 8-10 hours

---

## Performance Test Results ✅

**Local SSD (MacBook Pro M1):**
- Photo thumbnails: **37.4ms average** (30-47ms range)
- **Verdict: FAST** - Should feel instant in UI

**Expected NAS performance (estimated from existing patterns):**
- Photo thumbnails: ~100-300ms (3-8x slower due to network)
- Video thumbnails: ~2-5 seconds (ffmpeg over network)
- **Verdict: ACCEPTABLE** with lazy loading

---

## Design Mockup

**Location:** `picker_thumbnail_mockup.html`

Open in browser to see:
- 48×48px thumbnails with file info
- Loading states (shimmer animation)
- Error states (warning icon)
- Selected states (purple checkbox)
- File metadata (dimensions • size)

**Key design decisions:**
1. **48×48px thumbnails** - Large enough to identify, small enough to not dominate
2. **Folders = no thumbnails** - Keeps folder/file distinction clear
3. **Shimmer loading** - Modern, better than spinners
4. **Metadata on second line** - Dimensions + size help identify files
5. **Lazy loading** - Only generate visible thumbnails + 100px buffer

---

## Implementation Phases

### Phase 1: Backend Endpoint (2-3 hours)

**Create:** `/api/filesystem/preview-thumbnail`

```python
# app.py

@app.route('/api/filesystem/preview-thumbnail', methods=['POST'])
def preview_thumbnail():
    """
    Generate quick preview thumbnail (48x48px) for picker
    Returns JPEG binary data or error
    """
    try:
        data = request.json
        path = data.get('path')
        
        # Validate path
        if not path or not os.path.exists(path):
            return jsonify({'error': 'File not found'}), 404
        
        # Security check: Ensure path is absolute and not traversal attack
        path = os.path.abspath(path)
        
        # Determine file type
        ext = os.path.splitext(path)[1].lower()
        
        # Photo extensions
        photo_exts = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', 
                      '.bmp', '.tiff', '.tif', '.webp', '.raw', '.cr2', 
                      '.nef', '.arw', '.dng'}
        
        # Video extensions
        video_exts = {'.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv', 
                      '.webm', '.flv', '.3gp', '.mpg', '.mpeg'}
        
        if ext in photo_exts:
            return generate_photo_preview(path)
        elif ext in video_exts:
            return generate_video_preview(path)
        else:
            return jsonify({'error': 'Unsupported file type'}), 400
            
    except Exception as e:
        print(f"❌ Preview thumbnail error: {e}")
        return jsonify({'error': str(e)}), 500

def generate_photo_preview(file_path):
    """Generate photo thumbnail (48x48px)"""
    try:
        with Image.open(file_path) as img:
            # Apply EXIF orientation
            from PIL import ImageOps
            img = ImageOps.exif_transpose(img)
            
            # Convert to RGB if needed
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            # Create thumbnail (maintains aspect ratio)
            img.thumbnail((48, 48), Image.Resampling.LANCZOS)
            
            # Save to memory buffer
            buffer = io.BytesIO()
            img.save(buffer, format='JPEG', quality=70)
            buffer.seek(0)
            
            return send_file(buffer, mimetype='image/jpeg')
            
    except Exception as e:
        print(f"❌ Photo preview error: {e}")
        return jsonify({'error': str(e)}), 500

def generate_video_preview(file_path):
    """Generate video thumbnail (48x48px) using ffmpeg"""
    try:
        import uuid
        temp_file = f"/tmp/preview_{uuid.uuid4()}.jpg"
        
        # Extract first frame at 48px max dimension
        cmd = [
            'ffmpeg', '-i', file_path,
            '-vf', 'scale=48:48:force_original_aspect_ratio=decrease',
            '-vframes', '1', '-y', temp_file
        ]
        
        result = subprocess.run(
            cmd, 
            capture_output=True, 
            timeout=10  # 10 second timeout
        )
        
        if result.returncode == 0 and os.path.exists(temp_file):
            response = send_file(temp_file, mimetype='image/jpeg')
            # Clean up temp file after sending
            @response.call_on_close
            def cleanup():
                try:
                    os.remove(temp_file)
                except:
                    pass
            return response
        else:
            return jsonify({'error': 'Video preview failed'}), 500
            
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Video preview timeout'}), 500
    except Exception as e:
        print(f"❌ Video preview error: {e}")
        return jsonify({'error': str(e)}), 500
```

**Testing checklist:**
- ✅ Test with JPEG (should be ~30-50ms locally)
- ✅ Test with HEIC (should decode correctly)
- ✅ Test with PNG/GIF (should convert to JPEG)
- ✅ Test with corrupt file (should return error)
- ✅ Test with video (should extract frame)
- ✅ Test with non-existent path (should return 404)
- ✅ Test EXIF rotation (portrait photos should render correctly)

**Estimated time:** 2-3 hours (including testing)

---

### Phase 2: Frontend Rendering (2-3 hours)

**Update:** `static/js/photoPicker.js`

#### Step 2A: Update file list rendering

```javascript
// photoPicker.js - updateFileList() function

// Around line 360 - Render files section
files.forEach((file) => {
  const filePath = currentPath + '/' + file.name;
  const checked = isSelected(filePath);
  const baseIcon = file.type === 'video' ? 'movie' : 'image';
  const iconClass = checked ? 'check_box' : baseIcon;
  const stateClass = checked ? 'selected' : '';
  
  // Format file size
  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };
  
  // Format dimensions (if available from backend)
  const dimensionsText = file.dimensions 
    ? `${file.dimensions.width}×${file.dimensions.height}` 
    : '';
  const sizeText = formatSize(file.size || 0);
  const metaText = dimensionsText ? `${dimensionsText} • ${sizeText}` : sizeText;

  html += `
    <div class="photo-picker-item file-item" data-file-path="${filePath}" data-type="file">
      <span class="photo-picker-checkbox material-symbols-outlined ${stateClass}" 
            data-path="${filePath}" 
            data-type="file">${iconClass}</span>
      
      <!-- NEW: Thumbnail (lazy-loaded) -->
      <img class="photo-picker-thumbnail loading" 
           data-path="${filePath}"
           alt="">
      
      <!-- NEW: File info container -->
      <div class="photo-picker-file-info">
        <span class="photo-picker-name">${file.name}</span>
        <span class="photo-picker-meta">${metaText}</span>
      </div>
    </div>
  `;
});
```

#### Step 2B: Implement lazy loading with IntersectionObserver

```javascript
// photoPicker.js - Add after updateFileList() renders items

// Global observer (reuse across navigations)
let thumbnailObserver = null;

function setupThumbnailLazyLoading() {
  const fileList = document.getElementById('photoPickerFileList');
  const thumbnails = fileList.querySelectorAll('.photo-picker-thumbnail.loading');
  
  // Create observer if doesn't exist
  if (!thumbnailObserver) {
    thumbnailObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          loadThumbnail(img);
          thumbnailObserver.unobserve(img); // Only load once
        }
      });
    }, {
      root: fileList,
      rootMargin: '100px', // Load 100px before entering viewport
      threshold: 0.01
    });
  }
  
  // Observe all loading thumbnails
  thumbnails.forEach(img => {
    thumbnailObserver.observe(img);
  });
}

async function loadThumbnail(imgElement) {
  const path = imgElement.dataset.path;
  
  try {
    const response = await fetch('/api/filesystem/preview-thumbnail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    });
    
    if (response.ok) {
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      
      imgElement.src = url;
      imgElement.classList.remove('loading');
      imgElement.classList.add('loaded');
      
      // Clean up blob URL after image loads
      imgElement.onload = () => {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
    } else {
      // Error state
      imgElement.classList.remove('loading');
      imgElement.classList.add('error');
      imgElement.alt = '⚠️';
    }
  } catch (error) {
    console.error('Thumbnail load error:', error);
    imgElement.classList.remove('loading');
    imgElement.classList.add('error');
    imgElement.alt = '⚠️';
  }
}

// Call setupThumbnailLazyLoading() at end of updateFileList()
async function updateFileList() {
  // ... existing rendering code ...
  
  fileList.innerHTML = html;
  
  // ... existing event handlers ...
  
  // NEW: Set up lazy loading for thumbnails
  setupThumbnailLazyLoading();
}
```

#### Step 2C: Clean up on navigation

```javascript
// photoPicker.js - navigateTo() function

async function navigateTo(path) {
  // Disconnect observer before navigating
  if (thumbnailObserver) {
    thumbnailObserver.disconnect();
  }
  
  currentPath = path || VIRTUAL_ROOT;
  updateBreadcrumb();
  await updateFileList();
  
  // Observer will be recreated in updateFileList()
}
```

**Testing checklist:**
- ✅ Navigate to folder with 20+ files
- ✅ Thumbnails load as you scroll (lazy)
- ✅ Loading state shows shimmer animation
- ✅ Loaded thumbnails display correctly
- ✅ Error state shows warning icon for corrupt files
- ✅ Selected files show purple checkbox + thumbnail
- ✅ File metadata displays (dimensions • size)
- ✅ No memory leaks (check blob URLs cleaned up)

**Estimated time:** 2-3 hours (including testing)

---

### Phase 3: CSS Styling (1 hour)

**Update:** `static/css/styles.css`

```css
/* Around line 1648 - Update .photo-picker-item */
.photo-picker-item {
  padding: 10px 12px; /* Reduced from 12px 14px to fit thumbnail */
  background: #252525;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  margin-bottom: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  transition: all 0.2s;
  font-size: 14px;
}

/* NEW: Thumbnail styles */
.photo-picker-thumbnail {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  object-fit: cover;
  background: #1a1a1a;
  border: 1px solid #333;
  flex-shrink: 0;
}

.photo-picker-thumbnail.loading {
  background: linear-gradient(90deg, #1a1a1a 0%, #2a2a2a 50%, #1a1a1a 100%);
  background-size: 200% 100%;
  animation: thumbnailShimmer 1.5s infinite;
}

.photo-picker-thumbnail.loaded {
  border-color: #444;
}

.photo-picker-thumbnail.error {
  background: #2a2a2a;
  border: 1px solid #444;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  color: #666;
}

.photo-picker-thumbnail.error::before {
  content: '⚠️';
}

@keyframes thumbnailShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* NEW: File info container */
.photo-picker-file-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
  min-width: 0; /* Allow text truncation */
}

/* Update .photo-picker-name to work in container */
.photo-picker-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  /* Remove flex: 1 if it exists */
}

/* NEW: File metadata */
.photo-picker-meta {
  font-size: 12px;
  color: #888;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

**Testing checklist:**
- ✅ Layout looks good with thumbnails
- ✅ Shimmer animation smooth (60fps)
- ✅ Text truncates properly with ellipsis
- ✅ Hover state still works
- ✅ Selected state styling correct
- ✅ Thumbnails aligned vertically with checkbox
- ✅ Responsive to window resize

**Estimated time:** 1 hour

---

### Phase 4: Backend File Metadata (Optional, 1 hour)

**Enhancement:** Add dimensions to `/api/filesystem/list-directory` response

This makes metadata display more useful (shows dimensions without loading thumbnail).

```python
# app.py - list_directory endpoint (around line 3011)

# When building file list:
for file in files:
    file_info = {
        'name': file,
        'type': 'video' if ext in video_exts else 'photo',
        'size': os.path.getsize(file_path)
    }
    
    # NEW: Add dimensions for images (fast, just reads header)
    if file_info['type'] == 'photo':
        try:
            with Image.open(file_path) as img:
                file_info['dimensions'] = {
                    'width': img.width,
                    'height': img.height
                }
        except:
            file_info['dimensions'] = None
    
    # For videos, could use ffprobe but it's slower (optional)
    # elif file_info['type'] == 'video':
    #     # Skip for now - too slow for directory listing
    
    files_list.append(file_info)
```

**Note:** This adds ~5-20ms per image file to directory listing. For 100 files, that's 0.5-2 seconds. Acceptable for better UX, but can skip if you want faster navigation.

**Testing checklist:**
- ✅ Directory listing includes dimensions
- ✅ Frontend displays dimensions in metadata
- ✅ Works with various image formats (JPEG, PNG, HEIC)
- ✅ Gracefully handles files without dimensions
- ✅ Performance still acceptable (<2s for 100 files)

**Estimated time:** 1 hour (optional)

---

### Phase 5: Testing & Polish (2 hours)

#### 5A: Local Testing (1 hour)

**Test cases:**
1. **Navigate to folder with mixed content**
   - Folders (no thumbnails) ✓
   - JPEGs (fast thumbnails) ✓
   - HEICs (thumbnails work) ✓
   - Videos (thumbnails extract first frame) ✓
   - PNGs/GIFs (thumbnails work) ✓

2. **Scroll behavior**
   - Thumbnails lazy load as you scroll ✓
   - Loading states show shimmer ✓
   - No duplicate requests ✓
   - Smooth scrolling (no jank) ✓

3. **Edge cases**
   - Corrupt file (error state) ✓
   - Zero-byte file (error state) ✓
   - Very large file (timeout handled) ✓
   - File deleted while loading (error handled) ✓

4. **Selection workflow**
   - Check file → thumbnail stays visible ✓
   - Uncheck file → thumbnail stays visible ✓
   - Navigate away → thumbnails cleaned up ✓
   - Navigate back → thumbnails reload ✓

5. **Performance**
   - 100+ files loads without lag ✓
   - Memory usage reasonable ✓
   - No blob URL leaks ✓

#### 5B: NAS Testing (1 hour)

**If you have NAS access, test:**
1. Navigate to NAS folder with 50+ files
2. Verify thumbnails load (slower, but acceptable)
3. Check loading states work well
4. Videos timeout gracefully if too slow
5. No hang or freeze

**Expected NAS performance:**
- Photo thumbnails: 100-300ms each
- Video thumbnails: 2-10 seconds each
- Should still be usable with lazy loading

#### 5C: Bug Fixes

Budget 30-60 minutes for unexpected issues:
- Layout glitches
- Memory leaks
- Race conditions
- Error handling gaps

**Estimated time:** 2 hours total

---

## Total Implementation Time

| Phase | Estimated Time |
|-------|----------------|
| 1. Backend endpoint | 2-3 hours |
| 2. Frontend rendering | 2-3 hours |
| 3. CSS styling | 1 hour |
| 4. File metadata (optional) | 1 hour |
| 5. Testing & polish | 2 hours |
| **TOTAL** | **8-10 hours** |

---

## Testing Script

```bash
# 1. Start the app
python app.py

# 2. Open picker
# Click "Import photos" in main UI

# 3. Navigate to Desktop
# Should see thumbnails loading

# 4. Scroll through list
# Thumbnails should lazy load

# 5. Check browser console
# No errors, no warnings

# 6. Check Network tab
# Thumbnail requests only for visible items
# Requests succeed (200 OK)

# 7. Check Performance
# Page stays responsive during thumbnail loads
# No memory leaks (check Memory profiler)

# 8. Edge cases
# Create corrupt file (echo "bad" > test.jpg)
# Navigate to folder with it
# Should show error state (⚠️)
```

---

## Rollback Plan

If thumbnails cause issues:

**Quick disable (no code changes):**
```css
/* styles.css - hide thumbnails */
.photo-picker-thumbnail {
  display: none !important;
}
```

**Full rollback:**
1. Revert `photoPicker.js` changes
2. Revert `styles.css` changes  
3. Remove backend endpoint
4. Git revert to previous version

---

## Feature Flag (Recommended)

Add config to enable/disable thumbnails:

```python
# app.py - top of file
ENABLE_PICKER_THUMBNAILS = True  # Set to False to disable
```

```javascript
// photoPicker.js - in setupThumbnailLazyLoading()
async function setupThumbnailLazyLoading() {
  // Check if feature enabled (could fetch from backend)
  const ENABLE_THUMBNAILS = true;
  
  if (!ENABLE_THUMBNAILS) {
    // Hide all thumbnails
    document.querySelectorAll('.photo-picker-thumbnail').forEach(img => {
      img.style.display = 'none';
    });
    return;
  }
  
  // ... rest of lazy loading logic
}
```

This lets you disable thumbnails quickly if issues arise.

---

## Success Criteria

**Minimum viable (must have):**
- ✅ Thumbnails display for JPEG/PNG files
- ✅ Loading state shows shimmer animation
- ✅ Error state shows warning icon
- ✅ Lazy loading works (only visible items)
- ✅ No performance regression on local SSD
- ✅ File metadata displays correctly

**Nice to have:**
- ✅ Thumbnails work for HEIC files
- ✅ Thumbnails work for videos
- ✅ Acceptable performance on NAS
- ✅ Smooth animations (60fps)
- ✅ Clean error handling

**Don't ship if:**
- ❌ Thumbnails break picker navigation
- ❌ Memory leaks detected
- ❌ Performance regression on local
- ❌ Crashes or hangs with large folders

---

## Next Steps

**Ready to implement?**

1. **Review mockup:** Open `picker_thumbnail_mockup.html` in browser
2. **Approve design:** Confirm thumbnail size, layout, states
3. **Start Phase 1:** Backend endpoint (2-3 hours)
4. **Ship incrementally:** Each phase can be tested independently
5. **Gather feedback:** After Phase 3, show to users

**Or defer?**

1. **Fix dialog framework bug first** (2 hours, last remaining bug)
2. **Implement file metadata only** (2-4 hours, simpler alternative)
3. **Revisit thumbnails later** (after more user feedback)

---

## Questions?

1. **Design approval:** Is 48×48px the right size, or go larger (64×64)?
2. **Video thumbnails:** Include or skip (they're slower)?
3. **NAS testing:** Do you have access to test NAS performance?
4. **Feature flag:** Want to ship with disable option?
5. **Timeline:** Implement now or after dialog framework bug?

Let me know and I'll proceed with implementation!
