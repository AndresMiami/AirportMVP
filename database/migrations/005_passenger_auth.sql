-- Migration 005: Link customers to Supabase Auth users
-- Run this in the Supabase SQL Editor.
--
-- Ports the CreditEngine hub-table pattern: auth.uid() -> customers.user_id
-- -> customers.id -> bookings.customer_id. Improves on the original by
-- constraining the column (UNIQUE + FK) as the audit recommended.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id);
