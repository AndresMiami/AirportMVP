# Project Organization Plan - Airport MVP

## Current Dependencies Analysis

### Critical File Dependencies in indexMVP.html:
1. **CSS Imports**:
   - `style.css` (relative path)
   - `maps-autocomplete.css` (relative path)

2. **JavaScript Imports**:
   - `./autocomplete.js` (ES6 module import)
   - `./pricing.js` (dynamic import in script)

3. **Image References**:
   - `./images/luxury-sedan.jpg`
   - `./images/premium-suv-escalade.jpg`
   - `./images/vip-sprinter.jpg`

4. **API Configuration**:
   - `api-config.js` (used by autocomplete.js)
   - Proxy server endpoints configured in api-config.js

### Dependencies that MUST Stay Together:
- `indexMVP.html` + `autocomplete.js` + `api-config.js` (tightly coupled)
- `style.css` + `maps-autocomplete.css` (both required for UI)
- `pricing.js` or `pricing-simple.js` (loaded dynamically)

## Proposed Organization (SAFE Approach)

### Option 1: Minimal Reorganization (RECOMMENDED)
Keep core files in root, organize only non-critical files:

```
/AirportMVP
├── indexMVP.html                    [STAY IN ROOT]
├── Driver.html                      [STAY IN ROOT]
├── Passenger.html                   [STAY IN ROOT]
├── LandingLOGIN.html               [STAY IN ROOT]
├── autocomplete.js                  [STAY IN ROOT]
├── api-config.js                    [STAY IN ROOT]
├── pricing.js                       [STAY IN ROOT - consolidate with pricing-simple.js]
├── style.css                        [STAY IN ROOT]
├── maps-autocomplete.css            [STAY IN ROOT]
├── supabase.js                      [STAY IN ROOT]
├── datetime-utils.js                [STAY IN ROOT]
│
├── /images                          [EXISTING - keep as is]
│   ├── luxury-sedan.jpg
│   ├── premium-suv-escalade.jpg
│   └── vip-sprinter.jpg
│
├── /business-templates              [NEW FOLDER]
│   └── Medical_transport_demo.html
│
├── /admin-tools                     [NEW FOLDER]
│   └── api-cost-dashboard.html
│
├── /netlify                         [EXISTING - keep as is]
│   └── /functions
│
├── /docs                            [EXISTING - keep as is]
│
├── /airport-booking-api-proxy       [EXISTING - keep as is]
│
└── /archive                         [NEW FOLDER - for old/unused files]
    ├── pricing-simple.js            [after merging with pricing.js]
    └── airport-transfer-system/     [empty directory structure]
```

### Option 2: Full Reorganization (RISKY - Requires Path Updates)
Complete restructure with all path updates:

```
/AirportMVP
├── index.html                       [RENAME from indexMVP.html]
├── /app                             [NEW - main application files]
│   ├── Driver.html
│   ├── Passenger.html
│   └── LandingLOGIN.html
│
├── /assets                          [NEW - all static assets]
│   ├── /css
│   │   ├── style.css
│   │   └── maps-autocomplete.css
│   ├── /js
│   │   ├── autocomplete.js
│   │   ├── api-config.js
│   │   ├── pricing.js
│   │   ├── supabase.js
│   │   └── datetime-utils.js
│   └── /images
│       ├── luxury-sedan.jpg
│       ├── premium-suv-escalade.jpg
│       └── vip-sprinter.jpg
│
├── /business-templates
│   └── Medical_transport_demo.html
│
├── /admin-tools
│   └── api-cost-dashboard.html
│
└── /netlify
    └── /functions
```

## Migration Steps for Option 1 (SAFE):

1. **Create new folders only**:
   ```bash
   mkdir business-templates
   mkdir admin-tools
   mkdir archive
   ```

2. **Move non-critical files**:
   ```bash
   mv Medical_transport_demo.html business-templates/
   mv api-cost-dashboard.html admin-tools/
   ```

3. **Consolidate pricing modules**:
   - Merge `pricing-simple.js` features into `pricing.js`
   - Archive `pricing-simple.js`

4. **Clean up empty directories**:
   ```bash
   mv airport-transfer-system archive/
   mv driver-app archive/
   mv tracking-app archive/
   ```

## Why Option 1 is Safer:

1. **No Path Updates Required**: All critical imports remain unchanged
2. **No Risk to API Integration**: `api-config.js` and `autocomplete.js` stay in place
3. **Netlify Functions Unaffected**: No changes to serverless function paths
4. **Easy Rollback**: Minimal changes mean easy reversal if issues arise
5. **Gradual Migration**: Can move to Option 2 later after testing

## Files That MUST NOT Move (Critical Dependencies):
- `indexMVP.html`
- `autocomplete.js`
- `api-config.js`
- `style.css`
- `maps-autocomplete.css`
- `pricing.js`
- `/images` folder
- `/netlify` folder

## Testing After Organization:

1. **Test Autocomplete**:
   - Address search functionality
   - API proxy connections
   - Session token management

2. **Test Pricing**:
   - Vehicle price calculations
   - Dynamic imports working

3. **Test UI**:
   - All styles loading correctly
   - Images displaying properly

4. **Test API Endpoints**:
   - Netlify functions responding
   - Proxy server connections

## Next Steps:

1. Implement Option 1 (minimal, safe reorganization)
2. Test all functionality
3. Document any issues
4. Consider Option 2 for future major refactor

---
*Created: August 2025*
*Priority: Use Option 1 for safety*