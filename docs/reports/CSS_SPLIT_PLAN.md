# CSS Code Splitting Plan

## Recommended 3-File Split (Minimal & Efficient)

### Option A: By Feature (RECOMMENDED)
Split into 3 files based on feature usage:

#### 1. **base.css** (~400 lines)
**Purpose**: Core styles that every page needs
- CSS Variables (`:root`)
- Reset styles (`*`, `body`, `button`, `input`)
- Common utilities (`.hidden`, animations)
- Basic layout (`.app-container`)

#### 2. **booking.css** (~1,400 lines)
**Purpose**: Main booking flow styles
- Progress bar and steps
- Panels and navigation
- Airport selection
- Date/time components
- Vehicle carousel and cards
- Payment sections
- Action buttons

#### 3. **modals.css** (~400 lines)
**Purpose**: Modal and overlay components (can be lazy-loaded)
- Full-screen modals
- Passenger selection modal
- Guest form modal
- Booking confirmation overlay
- Modal-specific animations

### Option B: By Loading Priority (Alternative)
Split into 2 files only:

#### 1. **critical.css** (~1,800 lines)
**What goes here**: Everything needed for initial render
- All base styles
- Main booking interface
- Vehicle selection
- Required immediately

#### 2. **deferred.css** (~400 lines)
**What goes here**: Can be loaded after initial paint
- Modals
- Confirmation screens
- Guest forms
- Edge case styles

## Implementation Strategy

### For Option A (3 files):
```html
<!-- In indexMVP.html -->
<link rel="stylesheet" href="base.css">
<link rel="stylesheet" href="booking.css">
<link rel="stylesheet" href="modals.css" media="print" onload="this.media='all'"> <!-- Lazy load -->
```

### For Option B (2 files):
```html
<!-- In indexMVP.html -->
<link rel="stylesheet" href="critical.css">
<link rel="preload" href="deferred.css" as="style" onload="this.onload=null;this.rel='stylesheet'">
```

## Benefits of Each Approach

### Option A Benefits (3 files):
- ✅ Clear separation of concerns
- ✅ Modals can be lazy-loaded (400 lines deferred)
- ✅ Easy to maintain
- ✅ Other pages can use just `base.css`

### Option B Benefits (2 files):
- ✅ Simpler (only 2 files)
- ✅ Less HTTP requests
- ✅ Still defers non-critical styles

## My Recommendation: **Option A (3 files)**

**Why?**
1. **base.css** can be shared across all pages (Driver.html, Passenger.html)
2. **modals.css** can be lazy-loaded (improves initial load)
3. Clear organization makes maintenance easier
4. Total of 3 files is still minimal

## File Size Estimates

### Option A (3 files):
- `base.css`: ~15KB
- `booking.css`: ~45KB  
- `modals.css`: ~12KB (lazy-loaded)
- **Initial Load**: 60KB (base + booking)

### Option B (2 files):
- `critical.css`: ~60KB
- `deferred.css`: ~12KB (lazy-loaded)
- **Initial Load**: 60KB

Both options have same initial load size, but Option A is more maintainable.

## Migration Steps

1. Create new CSS files
2. Move styles to appropriate files
3. Update HTML link tags
4. Test all functionality
5. Delete old `style.css`

Would you like to proceed with Option A (3 files) or Option B (2 files)?