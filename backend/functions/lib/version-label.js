// One grammar for every version identifier that crosses the pricing-card,
// quote-engine, resolver, and signed-token boundary. Pricing Studio may show a
// friendly display name separately; the published identifier is a stable slug.
const VERSION_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isValidVersionLabel(value) {
  return typeof value === 'string' && VERSION_LABEL_RE.test(value);
}

module.exports = { VERSION_LABEL_RE, isValidVersionLabel };
