# Security Configuration Guide

## 🔒 Current Security Status

### ✅ Secure (Protected)
- **Google Maps REST key**: Private in Railway and never sent to browsers
- **Google Maps browser key**: Public by design, isolated from the REST key,
  and protected by GCP Website + API restrictions
- **Telegram Bot Token**: Only on backend (Netlify Functions)

### 📌 Notes
- **Supabase anon key**: public by design and auth-only — since the RLS
  lockdown every table is default-deny with zero client-role grants, so the
  anon key cannot read or write data; all data access goes through Netlify
  functions holding `SUPABASE_SERVICE_KEY`
- **Payments**: cash/Zelle collected by the driver; no payment keys exist
  (legacy in-app card path archived under `dev/archive/legacy-stripe/`)

## 🛡️ Security Architecture

```
Frontend (Public)          Backend (Secure)
-----------------          -----------------
indexMVP.html              Railway Proxy
├─ Restricted browser key ├─ GOOGLE_MAPS_API_KEY
├─ Google JS direct       └─ Rate limiting
└─ REST calls via proxy
                          Netlify Functions
                          ├─ TELEGRAM_BOT_TOKEN
                          └─ SUPABASE_SERVICE_KEY
```

### Browser-key REST boundary observed in Deploy Preview

`GOOGLE_MAPS_BROWSER_API_KEY` is intentionally delivered to the browser and
must be treated as public. In a controlled Deploy Preview test, Google refused
direct requests using the dedicated preview key at each REST/web-service
endpoint LinkMia currently uses: Places Autocomplete, Place Details, Geocoding,
and Directions. The test covered requests carrying the expected preview
`Referer`, an unrelated `Referer`, and no `Referer`.

This is point-in-time evidence for that key's combined Website and API
restrictions—not proof that the key is secret, that all Google REST services
are universally unreachable, or that future configuration changes cannot
weaken the boundary. The Directions distinction is intentional: LinkMia uses
the browser key through the allowed Maps JavaScript API client-library path for
optional map rendering, while Railway uses a separate private server key for
REST/web-service requests. Never reuse the browser key as Railway's key or
broaden it to cover Railway's APIs.

Keep exact Website and API restrictions in place. Because Maps quotas are
project/API-wide and the Google Cloud project is shared with Railway, maintain
the recorded quota caps with enough room for both traffic paths. Keep the
project billing-budget alerts as well; those alerts warn about spend but do not
stop charges.

## 🔐 How to Secure Your Application

### 1. Never Commit Secrets
```bash
# Check .gitignore includes:
.env
.env.local
.env.production
*.key
*.pem
```

### 2. Local Development Setup
```bash
# Copy template
cp .env.example .env

# Edit .env with your real keys
nano .env

# NEVER commit .env file!
```

### 3. Production Setup

#### Netlify (Frontend + Functions)
1. Go to Site Settings → Environment Variables
2. Add the Netlify-only/function values required by the deployed code
   (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, server-side service/notification
   values, and the existing feature switches). Do **not** copy Railway's
   private `GOOGLE_MAPS_API_KEY` or proxy variables into Netlify.
3. Give `GOOGLE_MAPS_BROWSER_API_KEY` **Builds** scope with separate
   Production and Deploy Preview values (and Branch Deploy if enabled). It is
   public after the build; use exact website referrers and never reuse the
   Railway key.
4. Before merge, configure production first. A missing value leaves the last
   published deploy serving, but freezes all subsequent production deploys
   until a corrected build succeeds.
5. Deploy

#### Railway (API Proxy)
1. Go to Variables tab
2. Add:
   - `GOOGLE_MAPS_API_KEY`
   - `ALLOWED_ORIGINS`
   - `NODE_ENV=production`
3. During the stale-client transition, the private key still needs Maps
   JavaScript API as well as Places, Directions and Geocoding. Remove Maps
   JavaScript access when the old `/api/maps-script` route is retired.

### 4. Frontend Configuration

The frontend ships its Supabase URL and anon key in `supabase.js` on purpose:
the anon key is public and auth-only under the RLS lockdown. No other
credential belongs in frontend code.

## 🚨 Security Checklist

- [ ] All `.env` files in `.gitignore`
- [ ] No private keys hardcoded in JavaScript
- [ ] Browser key is dedicated and website/API restricted
- [ ] Maps JavaScript + Directions project quotas are capped and alerted
- [ ] Project-scoped Cloud Billing budget alerts are active (alerts do not cap)
- [ ] Private keys only in server environment variables
- [ ] Proxy server for external APIs
- [ ] CORS properly configured
- [ ] Rate limiting enabled
- [ ] HTTPS enforced in production
- [ ] Input validation on all forms
- [ ] SQL injection prevention (via Supabase)
- [ ] XSS protection headers

## 🔍 How to Check for Exposed Keys

```bash
# Search for potential exposed secrets
grep -r "sk_\|pk_\|API_KEY\|SECRET" --include="*.js" --include="*.html"

# Check git history for secrets
git log -S "sk_" --oneline
git log -S "API_KEY" --oneline
```

## 📝 Environment Variables Required

### Required for Basic Functionality
- `GOOGLE_MAPS_API_KEY` (Railway)
- `GOOGLE_MAPS_BROWSER_API_KEY` (Netlify Builds; public, restricted)
- `SUPABASE_URL` (Frontend/Backend)
- `SUPABASE_ANON_KEY` (Frontend/Backend; public, auth-only)
- `SUPABASE_SERVICE_KEY` (Backend only; secret)

### Required for Notifications
- `TELEGRAM_BOT_TOKEN` (Backend)
- `ADMIN_TELEGRAM_CHAT_ID` (Backend)

## 🆘 If Keys Are Exposed

1. **Immediately revoke** the exposed key
2. **Generate new keys** from provider dashboard
3. **Update** all deployments with new keys
4. **Check logs** for unauthorized usage
5. **Enable alerts** for unusual activity

## 📚 Resources

- [Google Maps API Security](https://developers.google.com/maps/api-security-best-practices)
- [Supabase Security](https://supabase.com/docs/guides/auth/security)
- [OWASP Security Guidelines](https://owasp.org/www-project-top-ten/)
