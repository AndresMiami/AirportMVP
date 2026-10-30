# Terminal panel motion polish

Status: implementation reviewed. Andres authorized commit, push and a draft PR
on 2026-10-30. Production release is not authorized.
Base: main at 22c04ee4dc42c7a44a1f49ef729e83c528c3e683 (PR #122).
User direction: polish the released terminal panel; defer the interactive map.
PR #123 remains separate and held. This is not implementation of its map plan.

## Experience

After a verified terminal is selected, the existing confirmation panel opens
in Where, using the existing selection-start boundary and pending controls.
The panel rises smoothly, the backdrop fades independently, and the selected
or checking terminal is already visible. The list scrolls inside the panel;
Confirm and Skip stay in place.

The handle and title follow a downward drag directly. A short pull settles
back; a deliberate long swipe or downward flick dismisses. Interrupted
gestures settle back instead of dismissing. Close, Escape, backdrop, Confirm
and Skip keep the released behavior. There is no new expanded/collapsed stage.

Timing choices inspired by the uploaded Uber video: 360 ms entrance,
420 ms gentle settle, 240 ms exit. These are LinkMia tuning values, not
measurements or copied Uber animation code. Reduced motion removes these
transitions and the closing wait. No animation package or framework added.

Rows retain the terminal, cruise companies and selected/checking label.
A two-line grid holds the status beside the terminal and the company below,
so the text does not reflow when Checking becomes Selected.

## Reliability

- Capture an interrupted entrance or settle at its visible position.
- One primary pointer owns the drag; old or secondary pointer events cannot
  cancel a newer panel's gesture.
- Use recent velocity rather than the whole drag's average for flicks.
- Cancellation/lost capture always returns to rest.
- Exit completion and the timeout belong to that particular overlay.
- An exiting overlay is inert. Reopening removes it before creating another.
- Initial focus reveals the checking/selected row without scrolling the page.
  Later renders never reposition the list.

Pricing, quotes, terminal identities, network requests, dropdown matching,
pending-booking edits, and driver navigation have no implementation changes.
No map library, markers, location fetching or additional API calls.

## Verification (2026-10-29)

- All 48 repository suites pass locally on Node 24.22.1, combining the full
  run with reruns of five environment-blocked suites after linking the existing
  dependencies and placing test scratch files under the isolated checkout.
- terminal-confirmation: 44 checks (37 existing + 7 new); rerun after the
  final focus change. Other suite results preceded that focused final change.
- Negative control: the seven new tests with main's original sheet module
  fail at B8 (pointercancel wrongly dismisses).
- JavaScript syntax and git diff whitespace checks pass.
- Actual edited component and CSS in the local browser harness:
  293 px and 390 px widths, 780 px and 580 px phone frames; Virgin and shared
  Terminal F; short pull returns, long drag dismisses; selected row visible;
  Confirm stays at y=470.5 while the short-phone list scrolls from 147.5 to 292.
  Checking/Selected row height stays 66.4 px for Terminal F.
- The harness simulates Details and host navigation. It makes no external
  Google call or booking and is not full booking-flow acceptance.

## Review follow-up (2026-10-30)

Claude independently reviewed the original patch and reproduced 48 passing
suites on a scratch checkout. His proposed velocity regression exposed more
than a test gap: the sampling loop retained an old point outside the recent
window when pointer events were sparse, diluting a slow pull followed by a
quick flick. The loop now retains only the last 100 ms, with a lone sample
yielding zero velocity. B15 covers both a final move event and movement first
reported by pointerup. The redundant release-time pause ternary is removed;
the release sample and recent window already handle a pause. The 300 ms exit
timer is documented as a fallback for the 240 ms CSS transition.

Focused verification: 45 terminal checks pass on Node 24.22.1. Replacing the
new window with either the original pruning loop or no pruning fails B15,
so the new test detects the actual regression. Script syntax and whitespace
checks pass. The earlier full-suite/browser results above belong to the
original patch; the full suite and physical-device timing were not rerun for
this focused correction.

The original visual timing remains unchanged. Matching backdrop/panel settle
durations and adding compositor hints are optional, pending evidence on a
physical phone. No speculative optimization or dismissal-threshold change.

Claude's focused re-review of the revised patch is complete (returned through
Andres, 2026-10-30): 45 terminal checks and all 48 suites / 1,489 checks passed
on a fresh scratch copy, local Node 24 in the default zone. Three mutations
(the old loop, no pruning, and a 1,000 ms window) each failed B15. His real-module
browser checks covered the late flick, release-only movement, slow movement,
pause, and small jitter. This records his independent evidence, not Node 20 CI
or a physical-device timing pass.

Still required: physical iPhone gestures/VoiceOver/reduced motion; Node 20 CI
and a Deploy Preview on the draft PR. No merge or release is authorized here.

## Review artifacts

Machine-local checkout paths, the temporary preview URL and launcher are
recorded in the relay review packet. They are review-time artifacts, not
deployment configuration. The local harness uses simulated lookups; its
server, patch exports and test scratch files must not be shipped.

The service-worker pair is v1.3.53 / runtime-v30 and the module URL is v=3.
The previous pair and v=2 already exist on held PR #123's preview; do not reuse
that cache identity for different code. GitHub main was rechecked at 22c04ee
when preparing the draft PR on 2026-10-30; it still uses v1.3.51 / runtime-v28.
Recheck current main before release.
A future revival of #123 must rebase and choose the next unused pair.
