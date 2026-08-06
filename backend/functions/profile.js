// Passenger profile endpoint (CreditEngine requireAuth pattern).
// The caller sends their Supabase session JWT as a Bearer token; we verify
// it with the anon-key client, then read/write their customers row with the
// service-role client. The anon key itself can do nothing here.
//   GET  /api/profile            -> { profile } or { profile: null }
//   POST /api/profile {name, phone, email?} -> upsert own row -> { profile }

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error('❌ Missing Supabase configuration');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  // ---- requireAuth: verify the caller's JWT ----
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  const authClient = createClient(supabaseUrl, anonKey);
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData?.user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
  }
  const user = userData.user;

  const db = createClient(supabaseUrl, serviceKey);

  try {
    if (event.httpMethod === 'GET') {
      const { data, error } = await db
        .from('customers')
        .select('id, name, phone, email')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        console.error('❌ Profile lookup failed:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
      }

      // Ambassador status: an active hosts row linked to this account
      let ambassador = null;
      const { data: host } = await db
        .from('hosts')
        .select('id, name, property_name, referral_code, commission_rate')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle();
      if (host) {
        ambassador = {
          name: host.name,
          organization: host.property_name,
          referralCode: host.referral_code,
          commissionRate: host.commission_rate
        };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ profile: data || null, ambassador }) };
    }

    if (event.httpMethod === 'POST') {
      const { name, phone, email } = JSON.parse(event.body || '{}');
      if (!name || !phone) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'name and phone are required' }) };
      }

      const { data: existing } = await db
        .from('customers')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();

      let result;
      if (existing) {
        result = await db
          .from('customers')
          .update({ name, phone, email: email || user.email || null })
          .eq('id', existing.id)
          .select('id, name, phone, email')
          .single();
      } else {
        result = await db
          .from('customers')
          .insert([{
            user_id: user.id,
            name,
            phone,
            email: email || user.email || null,
            type: 'guest',
            source: 'website'
          }])
          .select('id, name, phone, email')
          .single();
      }

      if (result.error) {
        console.error('❌ Profile save failed:', result.error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Save failed' }) };
      }
      console.log(`✅ Profile saved for user ${user.id}`);
      return { statusCode: 200, headers, body: JSON.stringify({ profile: result.data }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (error) {
    console.error('❌ profile error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
