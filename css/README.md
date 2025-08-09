# CSS Architecture

## File Organization

All CSS files are now organized in the `/css` folder for better project structure.

### Files:

1. **`style.css`** (1,571 lines)
   - CSS variables and design system
   - Core application styles
   - Main booking flow
   - Animations and utilities

2. **`vehicle-carousel.css`** (369 lines)
   - Vehicle selection carousel
   - Vehicle cards and badges

3. **`modals.css`** (451 lines)
   - All modal components
   - Lazy-loaded for performance

4. **`maps-autocomplete.css`** (76 lines)
   - Google Maps integration styles
   - Autocomplete dropdown styles

## Loading Order

```html
<!-- In indexMVP.html -->
<link rel="stylesheet" href="css/style.css">
<link rel="stylesheet" href="css/vehicle-carousel.css">
<link rel="stylesheet" href="css/modals.css" media="print" onload="this.media='all'">
<link rel="stylesheet" href="css/maps-autocomplete.css">
```

## Benefits

✅ Organized file structure
✅ Clear separation of concerns
✅ Easy to locate styles
✅ Better for version control
✅ Professional project structure