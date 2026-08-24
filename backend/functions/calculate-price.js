// Retired pricing endpoint — fail-closed compatibility stub.
//
// Netlify reserves /.netlify/functions/*, so that direct function URL cannot
// be protected by a redirect rule. Keeping this inert handler is the only way
// to make both the former public alias and reserved direct URL return 404.
// There is deliberately no pricing import, request parsing, or provider call.

exports.handler = async () => ({
  statusCode: 404,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store'
  },
  body: JSON.stringify({ error: 'calculate-price retired' })
});
