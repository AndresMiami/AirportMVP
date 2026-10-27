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

What this PR adds (current working tree based on `d57053a`, including the
compact-design corrections after Codex relay 0268). Record the final reviewed
commit and preview in the decision record before release:

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
   used. Does this exact treatment require changes or permission, including
   for the colors or a possible implication of affiliation? This question
   needs its own answer; absence of official logo artwork is not clearance.
   If needed, the reviewer can specify a neutral text/initials treatment for
   Andres to approve. Official logos/photos remain a separate future stage.

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
