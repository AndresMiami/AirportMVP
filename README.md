# LuxeRide Airport Transfer Booking System

A professional airport transfer booking platform with real-time pricing, Google Maps integration, and mobile-optimized interface.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Google Maps API key
- Supabase account (for database)
- Stripe account (for payments)

### Local Development

1. **Clone the repository**
```bash
git clone https://github.com/AndresMiami/AirportMVP.git
cd AirportMVP
```

2. **Install dependencies**
```bash
npm install
```

3. **Set up environment variables**
```bash
# Create .env file in backend/api-proxy/
cp config/.env.example backend/api-proxy/.env
# Add your Google Maps API key and other credentials
```

4. **Start the proxy server**
```bash
npm start  # Runs on http://localhost:3001
```

5. **Open the application**
```bash
# Use Live Server in VS Code or any static server
# Open indexMVP.html
```

## 🏗️ Project Structure

```
AirportMVP/
├── indexMVP.html           # Main application (single-page app)
├── css/                    # Stylesheets
│   ├── style.css          # Core styles and variables
│   ├── modals.css         # Modal dialogs
│   └── maps-autocomplete.css # Address autocomplete
│
├── backend/               # Backend services
│   ├── api-proxy/        # Google Maps proxy (Railway)
│   │   └── server.js     # Express server for API key protection
│   └── functions/        # Netlify serverless functions
│       ├── calculate-price.js
│       ├── create-booking.js
│       └── create-payment.js
│
├── JavaScript Modules (root)
│   ├── autocomplete.js   # Google Maps integration
│   ├── pricing.js        # Dynamic pricing logic
│   ├── datetime-utils.js # Date/time handling
│   ├── api-config.js     # API configuration
│   └── supabase.js       # Database client
│
├── images/               # Vehicle images
├── docs/                 # Documentation
│   ├── setup/           # Setup guides
│   ├── architecture/    # System design docs
│   └── reports/         # Migration reports
│
├── dev/                  # Development files
│   ├── admin/           # Admin dashboards
│   ├── archive/         # Old versions
│   └── templates/       # HTML templates
│
└── config files
    ├── netlify.toml      # Netlify configuration
    └── package.json      # Node dependencies
```

## 🔧 Configuration

### Environment Variables

**For Google Maps Proxy (backend/api-proxy/.env):**
```env
GOOGLE_MAPS_API_KEY=your_api_key_here
ALLOWED_ORIGINS=http://localhost:*,https://i-love-miami.netlify.app
NODE_ENV=production
PORT=3001
```

**For Netlify Functions (set in Netlify dashboard):**
```env
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_key
STRIPE_SECRET_KEY=your_stripe_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ADMIN_TELEGRAM_CHAT_ID=your_admin_chat_id
```

## 🚀 Deployment

### Frontend (Netlify)

1. Connect GitHub repository to Netlify
2. Build settings are auto-configured via `netlify.toml`
3. Add environment variables in Netlify dashboard
4. Deploy - auto deploys on push to main

**Live URL:** https://i-love-miami.netlify.app

### API Proxy (Railway)

1. Connect GitHub repository to Railway
2. Set root directory to `/backend/api-proxy`
3. Add environment variables in Railway dashboard
4. Deploy - auto deploys on push to main

**API URL:** https://reliable-warmth-production-d382.up.railway.app

## 💻 Development Workflow

### Making Changes

1. **Create a feature branch**
```bash
git checkout -b feature/your-feature
```

2. **Test locally**
- Start the proxy server: `npm start`
- Open `indexMVP.html` in Live Server
- Test all features thoroughly

3. **Commit changes**
```bash
git add .
git commit -m "feat: your feature description"
```

4. **Push and create PR**
```bash
git push origin feature/your-feature
# Create pull request on GitHub
```

### Testing Checklist

Before pushing changes, verify:

- [ ] Address autocomplete works
- [ ] Pricing calculates correctly
- [ ] Vehicle selection functions
- [ ] Date/time picker works
- [ ] Mobile responsive design
- [ ] No console errors

## 📋 Features

- **Real-time address autocomplete** via Google Maps
- **Dynamic pricing** based on distance and vehicle type
- **Mobile-optimized** responsive design
- **Secure payments** via Stripe
- **Telegram notifications** via Telegram Bot API
- **Database storage** via Supabase
- **Three vehicle types**: Luxury Sedan, Premium SUV, VIP Sprinter

## 🧪 API Endpoints

### Google Maps Proxy (Railway)
- `GET /health` - Health check
- `GET /api/places/autocomplete` - Address suggestions
- `GET /api/places/details` - Place details

### Netlify Functions
- `POST /api/calculate-price` - Calculate trip price
- `POST /api/create-booking` - Create new booking
- `POST /api/create-payment` - Process payment

## 🔒 Security

- Google Maps API key protected via proxy server
- All sensitive keys in environment variables
- CORS configured for allowed origins only
- Rate limiting on API proxy (100 req/15min)
- Secure payment processing via Stripe

## 📦 Dependencies

### Production
- `express: ^4.21.2` - API proxy server
- `stripe: ^18.4.0` - Payment processing
- `node-telegram-bot-api: ^0.66.0` - Telegram notifications

### Frontend (No build required)
- Vanilla JavaScript (ES6 modules)
- Google Maps API (via proxy)
- Supabase client library (CDN)

## 🐛 Troubleshooting

### Common Issues

**CSS not loading:**
- Ensure `/css` folder is committed to Git
- Check netlify.toml redirect rules

**Autocomplete not working:**
- Verify Google Maps API key is set
- Check Railway proxy is running
- Confirm CORS origins are configured

**Pricing not calculating:**
- Check Netlify functions are deployed
- Verify Supabase credentials

## 📝 Documentation

Detailed documentation available in `/docs`:

- [Setup Guide](docs/setup/GOOGLE_MAPS_SETUP.md)
- [Deployment Guide](docs/setup/DEPLOYMENT.md)
- [Architecture Overview](docs/architecture/REFINED_DIRECTORY_STRUCTURE.md)
- [Migration Reports](docs/reports/)

## 🤝 Contributing

1. Review existing issues or create new one
2. Fork the repository
3. Create feature branch from main
4. Make changes and test thoroughly
5. Submit pull request with clear description

### Code Standards

- Mobile-first CSS approach
- Clear variable and function names
- Comment complex logic
- Test on actual mobile devices
- No unnecessary dependencies

## 📄 License

Private repository - All rights reserved

## 🆘 Support

For issues or questions:
- Create GitHub issue with clear description
- Include browser console errors if applicable
- Specify device/browser for UI issues

## 🚦 Project Status

- **Version:** 1.0.0 (MVP)
- **Status:** Production
- **Last Updated:** August 2024
- **Active Deployments:**
  - Frontend: https://i-love-miami.netlify.app
  - API: https://reliable-warmth-production-d382.up.railway.app

---

Built with ❤️ for Miami airport transfers