# LinkMia Database & Admin Dashboard Setup

## Quick Start (15 minutes)

### Step 1: Run the Database Schema

1. Go to your Supabase project: https://supabase.com/dashboard
2. Click **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy the entire contents of `linkmia-schema.sql` and paste it
5. Click **Run** (or press Cmd+Enter)

You should see "Success. No rows returned" - this means the tables were created.

### Step 2: Verify Tables Created

In Supabase, go to **Table Editor**. You should see these tables:
- `customers`
- `drivers`
- `hosts`
- `bookings`
- `payments`
- `activity_log`

### Step 3: Add Your Driver Data

In the SQL Editor, run this to add yourself and any drivers:

```sql
-- Add yourself
INSERT INTO drivers (name, phone, vehicle_type, vehicle_details, status)
VALUES ('Andres', '+1-YOUR-PHONE', 'escalade', 'Black Escalade 2024', 'active');

-- Add backup drivers
INSERT INTO drivers (name, phone, vehicle_type, vehicle_details, status)
VALUES
    ('Carlos M.', '+1-555-000-0002', 'suv', 'Black Suburban 2023', 'active'),
    ('David R.', '+1-555-000-0003', 'sprinter', 'Black Sprinter 2022', 'active');
```

### Step 4: Add Your Existing Customers

```sql
INSERT INTO customers (name, phone, type, notes)
VALUES
    ('Chrissy Rice', '+1-555-123-4567', 'vip', 'Family group of 19, cruise customers'),
    ('Cruise Port Lady', '+1-555-234-5678', 'repeat', 'Regular cruise pickup');
```

### Step 5: Access the Admin Dashboard

1. Deploy your site to Netlify (if not already)
2. Go to: `https://your-site.netlify.app/admin.html`
3. Or locally: Open `admin.html` in your browser

The dashboard will:
- Show demo data if tables are empty
- Auto-sync with Supabase once you add real data
- Update in real-time when bookings change

---

## What Each Table Does

| Table | Purpose |
|-------|---------|
| `customers` | Store customer info, track VIPs, repeat customers |
| `drivers` | Your driver network with vehicle info |
| `hosts` | Airbnb/hotel hosts for referral tracking |
| `bookings` | Main dispatch table - all ride requests |
| `payments` | Track guest payments and driver payouts |
| `activity_log` | Audit trail of all changes |

---

## Admin Dashboard Features

### Today Tab
- Shows all bookings for today
- Quick status overview

### All Bookings Tab
- Complete booking history
- Click any booking to edit status, assign driver, update price

### Drivers Tab
- Your driver network
- See availability status

### Customers Tab
- Customer database
- VIP and repeat customer tracking

### Revenue Tab
- Total revenue and commission
- Monthly breakdown

### Quick Add (+)
- Floating button to add bookings fast
- Use this when you get a WhatsApp request

---

## Workflow: WhatsApp → Dashboard

1. **Guest texts you** on WhatsApp
2. **You respond** with quick reply template
3. **Tap the + button** on admin dashboard
4. **Enter booking details** (30 seconds)
5. **Assign yourself or another driver**
6. **Send confirmation** via WhatsApp

---

## Real-Time Updates

The dashboard uses Supabase real-time subscriptions. When a booking status changes:
- Dashboard updates automatically
- No need to refresh

---

## Troubleshooting

### "No rows returned" when running schema
This is normal! It means the tables were created successfully.

### Dashboard shows demo data
The dashboard falls back to demo data if:
- Tables don't exist yet
- Tables are empty
- Connection to Supabase fails

Once you add real data, it will show that instead.

### Can't see my bookings
Check that:
1. Tables were created (check Table Editor in Supabase)
2. Your Supabase URL and key are correct in the dashboard
3. RLS policies are allowing access

### How to reset and start fresh
```sql
-- WARNING: This deletes all data!
DROP TABLE IF EXISTS activity_log CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS bookings CASCADE;
DROP TABLE IF EXISTS hosts CASCADE;
DROP TABLE IF EXISTS drivers CASCADE;
DROP TABLE IF EXISTS customers CASCADE;

-- Then run linkmia-schema.sql again
```

---

## Next Steps

1. **Set up WhatsApp Business** - Add your quick reply templates
2. **Add your drivers** - Anyone you might dispatch to
3. **Log your first real booking** - Test the full flow
4. **Create driver WhatsApp group** - For multi-car coordination

---

## Files Reference

```
/database
├── linkmia-schema.sql    # Full database schema
└── SETUP.md              # This file

/admin.html               # Admin dashboard (deploy to Netlify)
```
