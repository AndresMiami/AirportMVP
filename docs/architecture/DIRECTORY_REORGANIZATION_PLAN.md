# Directory Reorganization Plan

## 🎯 Goal
Create a professional, scalable directory structure with clear separation of concerns for the Airport MVP project.

## 📁 Proposed New Structure

```
AirportMVP/
│
├── src/                      # Production code only
│   ├── frontend/            # Client-side code
│   │   ├── assets/         # Static assets
│   │   │   ├── css/       # Stylesheets
│   │   │   ├── images/    # Images
│   │   │   └── fonts/     # Custom fonts
│   │   ├── js/            # JavaScript modules
│   │   │   ├── core/      # Core functionality
│   │   │   ├── utils/     # Utility functions
│   │   │   └── vendor/    # Third-party libraries
│   │   └── pages/         # HTML pages
│   │       ├── index.html # Main booking page
│   │       └── driver.html
│   │
│   └── api/                # Client-side API integrations
│       ├── maps/          # Google Maps integration
│       └── booking/       # Booking API calls
│
├── backend/                 # Server-side code
│   ├── netlify/           # Netlify Functions
│   │   └── functions/     # Serverless functions
│   ├── proxy/             # API proxy server
│   └── config/            # Backend configurations
│
├── dev/                     # Development-only files
│   ├── templates/         # Business templates
│   ├── archive/           # Archived code
│   ├── admin-tools/       # Admin dashboards
│   └── tests/             # Test files
│
├── docs/                    # Documentation
│   ├── setup/             # Setup guides
│   ├── api/               # API documentation
│   ├── deployment/        # Deployment guides
│   └── reports/           # Analysis reports
│
├── config/                  # Configuration files
│   ├── netlify.toml       # Netlify config
│   ├── package.json       # NPM config
│   └── .env.example       # Environment template
│
├── public/                  # Public static files
│   └── (files served directly)
│
├── .gitignore
├── README.md
└── LICENSE
```

## 📋 File Migration Map

### Current → New Location

#### Production Files (src/)
```
indexMVP.html           → src/frontend/pages/index.html
Driver.html             → src/frontend/pages/driver.html
Passenger.html          → src/frontend/pages/passenger.html

css/style.css           → src/frontend/assets/css/style.css
css/modals.css          → src/frontend/assets/css/modals.css
css/vehicle-carousel.css → src/frontend/assets/css/vehicle-carousel.css
css/maps-autocomplete.css → src/frontend/assets/css/maps-autocomplete.css

pricing.js              → src/frontend/js/core/pricing.js
autocomplete.js         → src/frontend/js/core/autocomplete.js
datetime-utils.js       → src/frontend/js/utils/datetime-utils.js

images/                 → src/frontend/assets/images/
api-config.js          → src/api/config.js
```

#### Backend Files
```
netlify/functions/      → backend/netlify/functions/
airport-booking-api-proxy/ → backend/proxy/
```

#### Development Files
```
admin-tools/            → dev/admin-tools/
business-templates/     → dev/templates/
archive/                → dev/archive/
api-cost-dashboard.html → dev/admin-tools/api-cost-dashboard.html
Medical_transport_demo.html → dev/templates/medical-transport.html
```

#### Documentation
```
DEPLOYMENT.md           → docs/deployment/netlify.md
GOOGLE_MAPS_SETUP.md    → docs/setup/google-maps.md
IMPORTANT_FILES.md      → docs/project-structure.md
CSS_*.md files          → docs/reports/css-optimization/
CONSOLIDATION_REPORT.md → docs/reports/consolidation.md
```

#### Configuration
```
netlify.toml           → config/netlify.toml
package.json           → config/package.json
package-lock.json      → config/package-lock.json
.env.example           → config/.env.example
```

## 🔄 Migration Strategy

### Phase 1: Create New Structure (No Breaking Changes)
1. Create all new directories
2. Copy files to new locations
3. Keep originals temporarily

### Phase 2: Update References
1. Update all HTML file paths
2. Update JavaScript imports
3. Update CSS imports
4. Update configuration paths

### Phase 3: Test & Verify
1. Test all functionality
2. Verify all paths work
3. Check deployment works

### Phase 4: Cleanup
1. Remove old files
2. Update .gitignore
3. Update documentation

## ✅ Benefits of New Structure

### 1. **Clear Separation**
- Production code isolated in `src/`
- Development files in `dev/`
- Clean deployment process

### 2. **Scalability**
- Easy to add new features
- Clear where to put new files
- Modular architecture

### 3. **Maintainability**
- Easy to find files
- Logical grouping
- Self-documenting structure

### 4. **Team Collaboration**
- Clear boundaries
- Prevents accidental deployment of dev files
- Easy onboarding

### 5. **Deployment Ready**
- Deploy only `src/` folder
- Exclude dev files automatically
- Smaller production bundle

## 🚦 Implementation Order

1. **Documentation First**
   - Move all docs to `docs/`
   - Update references

2. **Development Files**
   - Move dev-only files to `dev/`
   - These have no dependencies

3. **Configuration**
   - Centralize config files
   - Update paths in configs

4. **Backend**
   - Isolate server-side code
   - Update function paths

5. **Frontend (Most Critical)**
   - Move in stages
   - Test after each move
   - Update all references

## ⚠️ Critical Considerations

### Files to Handle Carefully:
1. **indexMVP.html** - Main application file
2. **pricing.js** - Core business logic
3. **autocomplete.js** - Google Maps integration
4. **api-config.js** - API configuration

### Potential Issues:
- Relative path references in HTML/JS
- Netlify function paths
- Build/deployment scripts
- Git history preservation

### Mitigation:
- Create backup before starting
- Test locally after each phase
- Deploy to staging first
- Keep detailed migration log

## 📝 Next Steps

1. **Review & Approve** this plan
2. **Create backup** of current state
3. **Start with Phase 1** (non-breaking)
4. **Test thoroughly** after each phase
5. **Document changes** as we go

## 🎯 Success Criteria

- [ ] All functionality works as before
- [ ] No broken links or references
- [ ] Deployment still works
- [ ] Documentation is updated
- [ ] Team can navigate new structure
- [ ] Dev files excluded from production

---
*This reorganization will transform the project from a prototype structure to a production-ready architecture.*