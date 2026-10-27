# Session-token fallback for curated selections — review packet (NOT applied)

Status: prepared 2026-10-27 at Andres's direction (Codex relay 0279, checklist
Q7). This describes a change for review. Nothing here is implemented; applying
it is a separate decision and a reviewed change. Head inspected: `c2db70f`.

## 1. What happens today

- Typing starts a Legacy Place Autocomplete session: the browser creates a
  version-4 UUID token when none is live or the last one expired
  (`autocomplete.js:239-240`, `:170-181`) and sends it with every prediction
  request (`:248`).
- Selecting ANY row — a Google prediction or a LinkMia terminal row — calls
  Place Details (Legacy) through the Railway proxy WITH that session token
  (`autocomplete.js:538-551`), then `applySelection` ends the session with
  `clearSession()` (`:644`), so the next typing starts a fresh token.
- The proxy validates an optional token and forwards it only when present
  (`backend/api-proxy/server.js:316-322`, `:533`); it never creates one.
- Google's Legacy documentation (read 2026-10-27): a session is typing plus a
  selection plus one Place Details call; a concluded token is invalid; an
  omitted or reused token means each request is billed separately. It says
  nothing about a Details call for a place that was NOT one of the
  predictions — which is what a LinkMia row is. Checklist Q7 records that
  uncertainty; this packet is the fallback it names.

## 2. Proposed change (browser only)

In `selectSuggestion` (`autocomplete.js:538-551`): when `curated` is set,
build the Details request WITHOUT the `sessiontoken` parameter; when a Google
prediction is selected, keep today's request unchanged. Everything after the
request stays as it is: label, identity, coordinates, attributions, the
Details-failure fallback, the stale-selection sequence guard, and
`clearSession()` in `applySelection` (so the abandoned autocomplete session
is never reused for a later search — a later search gets a new token through
the existing `shouldGenerateNewSession` path).

Sketch (not applied):
```
const params = new URLSearchParams({ place_id: placeId });
if (!curated) params.set('sessiontoken', this.sessionToken);
```
The `generateSessionToken()` call just above (`:539-541`) becomes
Google-only as well; a curated selection needs no token.

Proxy: no change. `optionalSessionToken(undefined)` is accepted
(`server.js:316-322`) and the token is appended only when present (`:533`);
the proxy does not reintroduce one. The existing pin "the proxy forwards the
token untouched" (`tests/autocomplete-session.test.js:154-160`) stays valid.

## 3. Tests

- `tests/autocomplete-session.test.js:137-147` currently pins "the SAME
  token goes to both autocomplete and place details". Replace with two pins:
  a Google-prediction selection sends the token; a curated selection sends
  no `sessiontoken` parameter. Keep `:149-152` (session cleared after a
  successful selection) and add: cleared after a curated selection on both
  the success and the Details-failure path.
- `tests/curated-autocomplete.test.js`: assert the captured Details URL for
  a curated row has no `sessiontoken`, that a following search uses a NEW
  token, and that identity, label, attributions and the failure fallback
  are unchanged by the new request shape.
- Google-prediction scenarios in both suites stay byte-identical in
  expectation.

## 4. Billing (Google provider side; passenger fares unchanged)

Documented: with a valid token, a session's prediction requests are bundled
and only the Details request is charged; without a token, each request is
billed separately (Autocomplete per-request SKU, plus the Details request).
So, for a curated selection: the EXPECTED behaviour is that today the
prediction requests of that session are bundled into the Details call, and
after the change they are billed per request. This is expected behaviour
from the documentation, not a verified billing outcome: whether current
curated sessions actually receive bundled billing has not been measured,
and the number of prediction requests per session (debounced keystrokes)
and the resulting cost per booking are unmeasured estimates, not a cost
promise. Check the actual GCP billing report when the follow-up is
implemented. Pricing rules, quotes and the passenger's price are untouched
(Codex relay 0280 #4).

## 5. What this does not change

Terminal identity (the place ID sent to the quote service), the stored
label, attributions display, the coordinates lookup, the Details-failure
fallback, the stale-selection guards, Google-prediction behaviour, the
dropdown design, the service worker (a release of this change bumps the
pair as usual).

## 6. Decision for Andres

1. Keep today's behaviour (token sent on curated Details; uncertainty
   recorded in checklist Q7), or
2. apply this fallback as a small reviewed change before the dropdown
   release, or
3. apply it as its own follow-up PR after the release.
Recommendation: option 3 unless the checklist reviewer marks Q7 "Needs
change", in which case option 2 — the change is small and fully testable.
