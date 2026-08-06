# LinkMia Database Setup

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

### Step 5: Administration (LEGACY SECTION — admin.html is RETIRED)

The legacy `admin.html` dashboard was retired in the Phase B RLS lockdown
(it read production tables directly with the public anon key). `/admin`
now returns a 404 retirement notice.

Administration happens in the **Supabase Dashboard** (Table Editor + SQL
Editor) until the LinkMia admin portal ships. All application data access
flows through the Netlify functions' service key.

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

## Workflow: WhatsApp → Dashboard (LEGACY — admin.html retired)

1. **Guest texts you** on WhatsApp
2. **You respond** with quick reply template
3. **Add the booking** in the Supabase Table Editor (or have the guest
   book at linkmia.com — the normal path)
4. **Assign the driver** via the booking's `assigned_driver` column
5. **Send confirmation** via WhatsApp

---

## Troubleshooting

### "No rows returned" when running schema
This is normal! It means the tables were created successfully.

### Can't see my bookings
Check in the Supabase **Table Editor** (which uses your dashboard login,
not the locked-down public keys). Note: since migration 010 the public
anon key can read NOTHING by design — the app reads data only through
the Netlify functions' service key. A permission error from a client
key is the lockdown working, not a bug.

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

/admin-retired.html       # Retirement notice (legacy admin.html removed)
```
