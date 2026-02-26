# Security Configuration Guide

## 🔒 Current Security Status

### ✅ Secure (Protected)
- **Google Maps API Key**: Protected via Railway proxy server
- **Stripe Secret Key**: Only on backend (Netlify Functions)
- **Telegram Bot Token**: Only on backend (Netlify Functions)

### ⚠️ Needs Configuration
- **Supabase Credentials**: Currently using placeholders in `supabase.js`
- **Stripe Publishable Key**: Not yet configured for frontend

## 🛡️ Security Architecture

```
Frontend (Public)          Backend (Secure)
-----------------          -----------------
indexMVP.html              Railway Proxy
├─ NO API KEYS            ├─ GOOGLE_MAPS_API_KEY
├─ Uses proxy URLs        └─ Rate limiting
└─ Public keys only       
                          Netlify Functions
                          ├─ STRIPE_SECRET_KEY
                          ├─ TELEGRAM_BOT_TOKEN
                          └─ SUPABASE_SERVICE_KEY
```

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
2. Add all variables from `.env.example`
3. Deploy

#### Railway (API Proxy)
1. Go to Variables tab
2. Add:
   - `GOOGLE_MAPS_API_KEY`
   - `ALLOWED_ORIGINS`
   - `NODE_ENV=production`

### 4. Frontend Configuration

For Supabase in frontend, inject via script tag:
```html
<!-- Add before other scripts in indexMVP.html -->
<script>
  window.ENV = {
    SUPABASE_URL: 'your-url',
    SUPABASE_ANON_KEY: 'your-anon-key',
    STRIPE_PUBLISHABLE_KEY: 'pk_live_...'
  };
</script>
```

Or use Netlify environment variables with build plugin.

## 🚨 Security Checklist

- [ ] All `.env` files in `.gitignore`
- [ ] No hardcoded keys in JavaScript
- [ ] API keys only in environment variables
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
- `SUPABASE_URL` (Frontend/Backend)
- `SUPABASE_ANON_KEY` (Frontend/Backend)

### Required for Payments
- `STRIPE_SECRET_KEY` (Backend)
- `STRIPE_PUBLISHABLE_KEY` (Frontend)

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
- [Stripe Security](https://stripe.com/docs/security)
- [Supabase Security](https://supabase.com/docs/guides/auth/security)
- [OWASP Security Guidelines](https://owasp.org/www-project-top-ten/)