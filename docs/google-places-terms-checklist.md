# Google Places terms — release-gate checklist for the curated terminals (PR #120)

Purpose: a reviewer (Andres or counsel) reads Google's current terms once and
answers the questions below against the exact behaviour this PR ships. This
file describes the behaviour and names the clauses to read. It does **not**
state what the terms allow — that is the reviewer's finding, recorded at the
bottom. CLAUDE.md: "Do not infer policy answers."

Documents to read (current versions, read on the day of review):
- Google Maps Platform Terms of Service — https://cloud.google.com/maps-platform/terms
  (in particular the "Restrictions Against Misusing the Services" section:
  caching/storing, creating content from Google Maps Content, re-creating
  Google products, and the attribution requirements)
- Maps Platform Service Specific Terms — https://cloud.google.com/maps-platform/terms/maps-service-terms
  (the Places section: what may be stored and for how long; place IDs)
- Places API policies — https://developers.google.com/maps/documentation/places/web-service/policies
  (attribution, "Powered by Google" / Google Maps logo rules for Autocomplete
  outside a Google map, third-party attributions, prefetching/caching)
- Places Autocomplete policies / usage requirements —
  https://developers.google.com/maps/documentation/places/web-service/autocomplete
  (session tokens; what the service may be used for)

What this PR adds (head `c2db70f`, 2026-10-27; these behaviours are unchanged
since the compact-design corrections after Codex relay 0268 and the matcher
fix `c095d3b`). Record the final reviewed commit and preview in the decision
record before release:

| # | Behaviour | Where |
|---|---|---|
| A | LinkMia's own list of PortMiami cruise terminals: our own name and address text plus a Google **place ID** per terminal. No Google coordinates, no Google-returned text, no Google photos stored. | `data/curated-places.json` |
| B | In the address field's dropdown, matching terminal rows render **above** Google's Autocomplete predictions, in the same panel. Our rows show a colored plain-initials tile, company name, "PortMiami" subtitle and terminal badge. The street address appears after selection, not in these compact rows. Google's rows are unchanged (pin, Google's text). | `autocomplete.js` `curatedPresentation` / `renderDropdown`; `css/maps-autocomplete.css` |
| C | The Google Maps logo (Google's unmodified asset) renders whenever Google predictions are shown, in a sticky footer after them; it is **not** rendered when only our rows are shown. | `autocomplete.js` `GOOGLE_ATTRIBUTION_HTML`; `css/maps-autocomplete.css` `.google-maps-attribution` |
| D | Google's predictions are shown **intact** beneath our rows — a terminal may appear again in Google's own words; nothing of Google's is omitted or reordered. Our rows carry the caption "LinkMia terminals". A mixed list also shows our own "Google suggestions" caption above Google's rows; Google-only results have neither caption. (An earlier duplicate omission was removed on 2026-10-27.) | `autocomplete.js` `renderDropdown` |
| E | Selecting our row calls Google Place Details for that place ID (live, in the same Autocomplete session token), uses the returned coordinates, and displays every third-party attribution Details returns — but shows **our** label in the field instead of Google's formatted address. | `autocomplete.js` `selectSuggestion` / `applySelection` |
| F | The booking stores our label text for the address side (e.g. `PortMiami Terminal V, 718 N Cruise Blvd, Miami, FL 33132`) and the Google place ID (`canonical_place_id`, existing column). | `backend/functions/lib/curated-places.js`, `create-booking.js`, `update-pending-booking.js` |
| G | If Google's price-quote response names a different canonical place ID, the field falls back to Google's formatted address for that place (existing behaviour for Google-selected places). | `indexMVP.html` `reconcileQuoteLabel`, `js/pending-edit-card.js` |
| H | **Provenance in the registry file:** names, addresses and assignments are sourced from PortMiami's official pages (miamidade.gov/portmiami "Cruise Terminals" and "Directions to PortMiami", read 2026-10-27) and Andres's first-hand knowledge; each `source` cites those. No Google-returned text, coordinates or other Google content is stored; only the Google place ID is kept, as an identifier. (Before 2026-10-27 the provenance notes quoted Google's returned address strings and coordinates; those were removed on Codex's recommendation.) | `data/curated-places.json` `source` |

Not changed by this PR: Google content already stored by the existing booking
flow for ordinary (non-curated) addresses, coordinates captured at selection,
the Railway proxy's no-cache handling, and the open "durable address" question
recorded in CLAUDE.md — those stay on their own track.

## Questions for the reviewer (answer each Yes / No / Needs change)

1. **Mixed list (B).** Under the Terms' attribution and "no creating content
   from Google Maps Content / no re-creating Google products" clauses, may our
   own terminal rows appear in the same dropdown as Google's Autocomplete
   predictions, above them, provided ours are visibly ours and Google's keep
   Google's attribution? Fallback if No: render our rows in a separate list
   element above the Google dropdown rather than inside it (small change).

2. **Attribution placement (C).** Does rendering the Google Maps logo only
   when Google predictions are present, placed after Google's rows, satisfy
   the Autocomplete attribution requirement for a list shown without a
   Google map? The footer is already sticky while the panel scrolls; review
   its visibility, spacing and size on the final preview. Fallback if No:
   adjust the footer's placement/spacing to the requirement identified by
   the reviewer before release.

3. **Intact list and both source captions (D).** Is leaving Google's
   predictions intact, captioning ours "LinkMia terminals", and adding our
   own text "Google suggestions" above Google's rows consistent with the
   applicable attribution and Google brand guidelines? The latter caption
   is authored by LinkMia, not supplied by Google. Fallback if that caption
   needs change: remove or revise it as directed by the reviewer while
   retaining Google's intact results and required official attribution.
   (The earlier design omitted Google's duplicate of a place we show; that
   was removed before release, so nothing of Google's is filtered.)

4. **Our label on a Google-identified place (E, F).** May we display and
   store our own name/address text for a place that we identify by a Google
   place ID, while still calling Place Details for that ID and displaying its
   attributions? Fallback if No: store Google's formatted address as the label
   and show our name only in the dropdown row.

5. **Place ID storage (A, F).** Confirm that storing Google place IDs
   indefinitely in our registry and in `bookings.canonical_place_id` is
   within the Service Specific Terms' place-ID provision (this was already
   relied on by migration 017; the PR adds the registry file).

6. **Registry provenance text (H).** Confirm that a committed file holding
   our own name/address text sourced from PortMiami's official pages and
   Andres's knowledge, plus Google place IDs as identifiers only, raises no
   storage/caching issue. (The earlier draft quoted Google's returned address
   strings and coordinates in `source`; those were removed on 2026-10-27
   before release, so nothing Google-returned is stored in the registry.)

7. **Session tokens (E).** Our row's selection ends the Autocomplete session
   with a Place Details call, as a Google prediction's would. Confirm nothing
   in the Autocomplete usage requirements objects to a non-Google row closing
   a session this way. Fallback if No: call Details without the session token
   for curated rows (billing changes; behaviour does not).

8. **Cruise-company names, initials and colors (B).** Our rows show company
   names, plain initials (VV, C, RC, NCL, CC, MSC, D), and company-associated
   color treatments, with a neutral C/D tile for shared Terminal F. These
   tiles are LinkMia-authored artwork; no official company logo assets are
   used. Is this exact treatment acceptable as shipped — no changes and no
   permission needed, including for the colors and any implication of
   affiliation? (Normalized 2026-10-27 so that Yes means acceptable, like
   the other questions; a reviewer who sees a problem writes "Needs change"
   and what to change.) This question needs its own answer; absence of
   official logo artwork is not clearance.
   If needed, the reviewer can specify a neutral text/initials treatment for
   Andres to approve. Official logos/photos remain a separate future stage.

## Evidence record (2026-10-27, head `c2db70f`, preview deploy `6ae0e2a20fca5761311b5103`)

Written at Andres's direction (Codex relay 0279) so the reviewer decides on
evidence rather than certifying facts the agents can check. Three categories
are kept apart on every line: **documented rule** (what Google's text says,
with the section), **verified behaviour** (what the code does, with
file:line at `c2db70f`), and **interpretation** (a question the documents do
not settle — left for the reviewer, never answered here). CLAUDE.md: "Do not
infer policy answers."

Documents read on 2026-10-27, and how:
- Google Maps Platform Terms of Service (page states "Last modified August
  26, 2026") — read in the app browser (the page renders only with
  JavaScript). Sections used: the "Google Maps Content" definition; 3.2.2(b)
  Attribution; 3.2.3 Restrictions Against Misusing the Services (a) No
  Scraping, (b) No Caching, (c) No Creating Content From Google Maps
  Content, (d) No Re-Creating Google Products or Features, (e) No Use With
  Non-Google Maps; 4.2 Documentation.
- Maps Platform Service Specific Terms ("Last modified October 15, 2026") —
  app browser. Sections used: the general clause allowing Customer to cache
  Google ID values such as `place_id` per the Documentation; §14 Places API
  (Legacy and New): 14.1 use without a Google Map is allowed, 14.2 no use
  with a non-Google map, 14.3 latitude/longitude may be cached for up to 30
  consecutive calendar days.
- Places API policies page (developers.google.com …/places/web-service/policies,
  "Last updated 2026-10-23"; written for Places API (New), and the only
  attribution/policy page the Legacy Autocomplete page links to — there is
  no separate Legacy policies page: that URL answers 404). Sections used:
  Page summary (without a Google map the Google logo must be included;
  Places content must not be pre-fetched/cached/stored beyond the
  exceptions; place ID exempt), Google Maps attribution requirements (logo
  vs text attribution, logo size 16–19 dp, clear space 10 dp left/right/top
  and 5 dp bottom, unmodified, accessibility label "Google Maps"; placement
  near the top or bottom within the same visual container; never hidden or
  obscured), visual requirements (it must always be clear which content
  Google Maps provides; visually distinguish Google Maps Platform Content
  from other content; do not mix the attribution with other sources'
  content; do not attribute Google Maps with non-Google content),
  Exceptions from caching restrictions (place IDs may be stored
  indefinitely), Autocomplete for end user addresses (the address the end
  user selects is not subject to the content restrictions for that user's
  transaction; the list of suggestions is).
- Place Autocomplete (Legacy) page ("Last updated 2026-10-27"; Legacy
  banner: cannot be enabled for new Cloud projects as of October 2026,
  existing projects supported). Sections used: the note that the service
  may be used without a map and that without a map the Google logo must be
  displayed inline with the search field/results; session tokens (a session
  = typing + selection + Place Details; omitted or reused token → each
  request billed separately); "Don't programmatically parse the formatted
  address".
- Session Tokens (Legacy) page ("Last updated 2026-10-27"). Sections used:
  session definition and end; a concluded token is no longer valid; without
  a token each request is billed separately (Autocomplete per-request SKU);
  no statement about a Place Details call for a place that was not one of
  the predictions.

Services actually in use (verified in code): Place Autocomplete (Legacy)
and Place Details (Legacy) through the Railway proxy
(`backend/api-proxy/server.js:452-560`, fields `geometry,formatted_address`,
`html_attributions` sanitized and forwarded); Places API (New) `places.get`
server-side for quote resolution with field mask `id,formattedAddress`
(`backend/functions/lib/place-identity.js:133-138`); Maps JavaScript loaded
directly from Google (`maps-loader.js`). Billing address in the US (non-EEA
terms).

| Q | Documented rule (section) | Verified behaviour (file:line) | Evidence-backed conclusion | Unresolved (interpretation, for the reviewer) |
|---|---|---|---|---|
| 1 Mixed list | SST 14.1: Places content may be used without a Google map. ToS 3.2.3(e): not with or near a NON-Google map. Policies: it must always be clear which content Google Maps provides; visually distinguish Google Maps Platform Content from other content; do not mix Google's attribution with other sources' content. No rule on the policies page about mixing results from other sources in one list. | No map in the dropdown. LinkMia rows under the caption "LinkMia terminals" (`autocomplete.js:419-423`), Google's rows intact beneath under their own caption (`:439`), the Google logo footer after Google's rows only (`:442`, `:461`); row styling differs (`css/maps-autocomplete.css`). | The documented distinction and attribution rules are met as written: two captioned groups, Google's content untouched, Google's attribution tied to Google's rows. | Whether a mixed list is acceptable at all is not addressed by any document read. ToS 3.2.3(d)(iii) (no use of the Core Services "in a listings or directory service") is a general restriction whose application to an eight-terminal registry inside a ride-booking app is an interpretation. |
| 2 Logo | Legacy Autocomplete page: without a map, the Google logo inline with the search field/results. Policies: unmodified logo, height 16–19 dp, clear space 10/10/10/5 dp, non-outlined on plain backgrounds, accessibility label "Google Maps", near the top or bottom within the same container, never hidden or obscured; no attribution needed where no Google content is shown. | Unmodified official asset `images/google-maps-attribution-dark-gray.svg` at 98×18 px with `alt="Google Maps"` (`autocomplete.js:33-37`); sticky footer at the bottom of the same panel, padding 10 px left/right/top and 5 px bottom, plain white background (`css/maps-autocomplete.css:152-166`); rendered only when Google predictions are present (`:442`). | Every stated requirement is met: height 18 within 16–19, clear space equal to the minimums, label present, placement within the container, shown exactly when Google content is shown. | Asset provenance: the SVG is an Illustrator export named like Google's attribution asset; confirm it came from Google's attribution asset download (the policies page links the zip) — a fact Andres or whoever saved the file can confirm. The naming transition ("Google Maps" rather than "Google") is satisfied by this asset if it is the Google Maps attribution file. |
| 3 Captions | Policies: it must always be clear which content Google Maps provides; do not attribute Google Maps with non-Google content. Nothing on the policies page about captions authored by the customer. | "LinkMia terminals" over our rows; "Google suggestions" (LinkMia-authored text) over Google's rows in mixed lists only; Google-only lists carry neither caption (`autocomplete.js:419-439`). | The distinction rule is met; the official attribution is separate from the captions and never attached to our rows. | Whether a LinkMia-authored caption containing the word "Google" sits well with Google's brand guidelines (not on the pages read). A neutral caption ("Other suggestions") would remove the question without changing anything else; Andres's call. |
| 4 Our label for a Google-identified place | SST: place IDs may be cached per the Documentation; policies: stored indefinitely. SST 14.3: lat/lng cached ≤ 30 days. ToS 3.2.3(c): no creating content from Google Maps Content. Legacy page: don't programmatically parse Google's formatted address. | The label is LinkMia's own text (`data/curated-places.json`, `source` fields cite PortMiami's pages and Andres); it replaces the display label after Details (`autocomplete.js:574-576`) and is projected by the server from the registry (`backend/functions/lib/curated-places.js`); Google's `formatted_address` is not stored for curated rows; Details coordinates live in browser memory for the session and are never sent to the server (`create-booking.js` rejects client coordinates). | No Google content beyond the place ID is stored or derived; nothing is parsed from Google's address. | Whether showing our own text for a place identified by a Google ID could be read as "creating content from Google Maps Content" even though the text's provenance is independent — an interpretation; the provenance record exists to answer it. |
| 5 Place ID storage | SST general clause: `place_id` from Places API may be cached per the Documentation; policies: "store place ID values indefinitely". | Registry `placeId` per terminal; `bookings.canonical_place_id` (migration 017). | Within the documented exception. | None. |
| 6 Registry provenance | ToS 3.2.3(a): no copying and saving business names or addresses from Google Maps Content. | Registry `about` and every `source` cite PortMiami's official pages and Andres's knowledge; no Google text or coordinates (the earlier Google-quoting notes were removed 2026-10-27). | No Google content is stored in the registry. | None. |
| 7 Session tokens | Legacy pages: a session = typing + selection + Place Details; a concluded token is invalid; an omitted or reused token means per-request billing. No statement covers a Details call for a place that was not among the predictions. | A curated selection sends the current session token to Details (`autocomplete.js:538-551`), then `clearSession()` ends the session (`:644`); the next typing starts a new token (`:239-240`). The proxy forwards a token only when present (`backend/api-proxy/server.js:316-322`, `:533`). | No documented rule is broken and none expressly covers this case; the uncertainty is recorded, not resolved. The fallback (omit the token on curated Details) is prepared for review in `docs/plans/session-token-fallback-packet.md` and NOT applied. | Whether Google regards a curated (non-prediction) selection concluding a session as proper use. Andres decides between keeping today's behaviour and applying the fallback (per-request billing for those sessions; passenger fares unchanged). |
| 8 Company names, initials, colors | Nothing on the policies or terms pages read addresses third-party brand names, initials or colors shown beside Places results. | LinkMia-authored initials tiles, short names and colors, no official logo assets (`autocomplete.js:21-31`, `css/maps-autocomplete.css`). | Not a Google-terms question on the evidence; it is a trademark/affiliation question outside Google's documents. | Whether the treatment implies affiliation or needs permission — for Andres or counsel. |
| G (fallback label) | Policies: the end-user-selected address is outside the content restrictions for that user's transaction (New API wording); ToS 3.2.3(a)(iii) lists copying and saving addresses as scraping. | For a superseded canonical ID the field falls back to Google's formatted address and the booking stores it (`indexMVP.html` `reconcileQuoteLabel`), exactly as every Google-selected address has been stored before this PR. | Unchanged by this PR. | The pre-existing "durable address" question (CLAUDE.md) stays open on its own track. |

Facts outside the table: Place Details third-party attributions are
displayed in full or the selection fails closed (ToS 3.2.2(b);
`autocomplete.js:568-572`, `:702-716`; proxy `sanitizeAttributions`,
`server.js:549`). The Legacy Autocomplete/Details services are in Legacy
status (no new projects since October 2026; existing projects supported);
a migration to Places API (New) for the browser path is a separate,
unscheduled decision.

## Decision record

Reviewed commit: ___ · Preview/deploy: ___

Visual treatment to record explicitly: LinkMia-authored plain initials in
cruise-line-like colors, not supplied/licensed logo assets. This describes
provenance only; permission and branding conclusions remain for the reviewer.

| Date | Reviewer | Documents/versions read | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Changes required |
|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | |

A "Needs change" on any question is a code or data change on this branch
before merge, reviewed through the normal loop; a "No" with no acceptable
fallback blocks the release and goes back to Andres for a product decision.
