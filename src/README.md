# Source Directory (Production Code)

This directory contains **ONLY production-ready code** that will be deployed.

## Structure

- **`js/`** - JavaScript modules
  - `core/` - Business logic (pricing, booking, validation)
  - `utils/` - Reusable utilities (datetime, autocomplete)
  - `archive/` - Alternative implementations (preserved but not active)

- **`assets/`** - Static assets
  - `css/` - Stylesheets
  - `images/` - Images and graphics
  - `icons/` - UI icons
  - `fonts/` - Custom fonts

- **HTML Files** - Main application pages
  - `index.html` - Main booking interface
  - `driver.html` - Driver dashboard
  - `passenger.html` - Passenger view

## Guidelines

✅ **DO** place here:
- Production-ready code
- Optimized assets
- Core business logic
- User-facing interfaces

❌ **DON'T** place here:
- Test files
- Development tools
- Documentation
- Configuration files
- Admin dashboards