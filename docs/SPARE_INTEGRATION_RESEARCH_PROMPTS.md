# Spare Labs Integration Research Prompts

> **Purpose**: Use these prompts with AI research agents to validate Spare as a dispatch backend for LinkMia.

---

## Prompt 1: Technical API Research (For Manus)

Copy this prompt into Manus for deep documentation analysis:

```
# Research Task: Spare Labs Open API Technical Capabilities

## Objective
Investigate Spare Labs (sparelabs.com) developer documentation to determine if their Open API can support a custom airport transfer booking platform integration.

## Primary Research Sources
1. https://sparelabs.com/en/developers
2. https://developer.sparelabs.com (if exists)
3. https://docs.sparelabs.com (if exists)
4. Any Swagger/OpenAPI specification files
5. GitHub repositories from Spare Labs
6. Spare Labs developer blog or changelog

## Specific Questions to Answer

### API Capabilities
1. **Trip/Ride Creation**
   - What endpoint creates a new trip/ride request?
   - What are the required vs optional fields?
   - Can you specify exact pickup/dropoff coordinates (lat/lng)?
   - Can you specify a future scheduled pickup time (not just on-demand)?
   - Can you pass a pre-calculated fare/price or must you use their pricing?

2. **Vehicle Types**
   - Can you specify vehicle categories (sedan, SUV, van/sprinter)?
   - Is there support for luxury/black car service tiers?
   - Can you request specific vehicle capacities (4-pax, 7-pax, 12-pax)?

3. **Driver Assignment**
   - Is assignment automatic or can you manually assign drivers?
   - Can you integrate your own driver fleet vs using Spare's network?
   - What driver information is returned (name, photo, vehicle, plate)?

4. **Status Updates & Webhooks**
   - What webhook events are available? (driver_assigned, en_route, arrived, trip_started, trip_completed, cancelled)
   - What's the webhook payload structure?
   - Is there a polling endpoint for trip status?
   - Can you get real-time driver location updates?

5. **Authentication & Security**
   - What auth method? (API key, OAuth2, JWT)
   - Are there sandbox/test environments?
   - What are the rate limits?

6. **Pricing & Payments**
   - Can you handle payments externally (we use Stripe)?
   - Or does Spare require using their payment processing?
   - Can you pass your own fare quote to the driver?

7. **White-Labeling**
   - Can the customer-facing experience be branded (LinkMia vs Spare)?
   - What does the driver see - your brand or Spare's?

8. **Geographic Coverage**
   - Is the API available for Miami, Florida area?
   - Any geographic restrictions?

### Integration Patterns
1. Is there an SDK (JavaScript, Python, etc.) or just REST API?
2. Are there code examples or sample integrations?
3. What's the typical integration timeline mentioned in docs?
4. Any case studies of similar integrations (booking platform → Spare)?

### Limitations to Identify
1. What CAN'T you do with the API?
2. Any features that require enterprise/custom plans?
3. Minimum volume requirements?
4. Restrictions on trip types (airport transfers, long-distance)?

## Output Format
Please provide:
1. **Executive Summary** (3-5 bullet points on feasibility)
2. **API Endpoint Inventory** (table of relevant endpoints)
3. **Data Mapping Feasibility** (can our booking data map to their API?)
4. **Red Flags or Blockers** (anything that would prevent integration)
5. **Recommended Next Steps** (what to ask Spare sales team)

## Context About Our Platform
We're building LinkMia, a Miami airport transfer booking service. Our current booking captures:
- Customer name, phone, email
- Pickup address (text) + airport code (MIA/FLL/PBI)
- Pickup datetime
- Vehicle type (Tesla Model Y, Cadillac Escalade, Mercedes Sprinter)
- Passenger count
- Flight number (optional)
- Pre-calculated price ($75-$500 range)

We want Spare to handle driver dispatch, not customer booking. We keep the customer relationship.
```

---

## Prompt 2: Developer Experience Research (For Gemini)

Copy this prompt into Gemini for community sentiment analysis:

```
# Research Task: Developer Experiences Integrating with Spare Labs

## Objective
Find real-world experiences from developers and companies who have integrated with Spare Labs' dispatch/ride platform. Assess whether Spare is a reliable choice for a startup building a custom booking frontend.

## Research Areas

### 1. Developer Community Feedback
Search for discussions on:
- Reddit (r/startups, r/webdev, r/SaaS, r/transit)
- Hacker News (news.ycombinator.com)
- Stack Overflow
- Dev.to
- Twitter/X developer discussions
- LinkedIn posts from transit tech developers

**Search queries to try:**
- "Spare Labs API integration experience"
- "Spare Labs developer review"
- "sparelabs.com API"
- "Spare transit API vs building own dispatch"
- "microtransit API integration challenges"
- "ride dispatch API comparison"
- "Spare Labs vs Via vs RideCo"

### 2. Case Studies & Implementations
Find examples of:
- Companies that integrated Spare into their booking platform
- Transit agencies using Spare's white-label solution
- Startups that chose Spare over building their own
- Companies that LEFT Spare (and why)

### 3. Competitor Comparison
How does Spare compare to alternatives:
- **Via** (via.com) - rideshare/microtransit platform
- **RideCo** - on-demand transit software
- **TripSpark** - demand-response transit
- **Routematch** (now Uber Transit)
- **Building custom** with Google Maps + Twilio + custom driver app

For each, note:
- API availability for third-party integration
- Pricing model
- Developer experience reviews
- Flexibility for custom booking frontends

### 4. Pain Points to Uncover
Look for developers mentioning:
- API documentation quality
- Support responsiveness
- Breaking API changes
- Pricing surprises after scaling
- Geographic limitations
- Customization restrictions
- Driver app quality/reliability
- Webhook reliability

### 5. Success Stories
Find positive experiences mentioning:
- Fast integration timeline
- Good technical support
- Smooth driver onboarding
- Reliable dispatching
- Scalability

## Specific Questions to Answer

1. **Has anyone built a custom booking site that dispatches to Spare?**
   - What was their experience?
   - How long did integration take?
   - What problems did they encounter?

2. **Is Spare's API stable and well-documented?**
   - Any complaints about docs being outdated?
   - Breaking changes without notice?

3. **How is Spare's developer support?**
   - Response times?
   - Dedicated integration help?

4. **What's the real pricing like?**
   - Per-trip fees mentioned?
   - Setup costs?
   - Hidden fees?

5. **Any horror stories?**
   - Integration failures?
   - Drivers not showing up?
   - System outages?

6. **What do developers wish they knew before integrating?**

## Output Format

### Executive Summary
- Overall sentiment (positive/negative/mixed)
- Confidence level in Spare as a choice (high/medium/low)
- Top 3 concerns raised by developers
- Top 3 benefits mentioned

### Detailed Findings
For each source found, provide:
- Source (with link if available)
- Date (is it recent/relevant?)
- Context (who said it, what they were building)
- Key quote or finding
- Relevance to our use case (airport transfers in Miami)

### Alternative Recommendations
If research suggests Spare isn't ideal:
- What alternatives do developers recommend?
- Should we consider building our own?
- Hybrid approaches mentioned?

### Questions to Ask Spare Sales
Based on developer concerns found, what should we specifically ask Spare before committing?

## Our Context
We're a Miami airport transfer startup (LinkMia). We have:
- Working customer booking flow (web app)
- Stripe payment integration
- No driver app yet
- 3 vehicle types (sedan, SUV, sprinter van)
- Service area: Miami metro + airports (MIA, FLL, PBI)
- Expected volume: Starting with 10-50 trips/week, scaling to 200+/week

We want to validate if outsourcing dispatch to Spare is the right move vs building our own driver management system (which would take 3-4 months).
```

---

## Additional Research: Alternative Dispatch Providers

If Spare doesn't pan out, also research these alternatives:

### Prompt 3: Alternative Dispatch API Research

```
# Research: Dispatch API Alternatives to Spare Labs

Find and compare these dispatch/ride platform APIs for a custom airport transfer booking integration:

## Providers to Research
1. **Via** (via.com/transit) - Their Transit-as-a-Service API
2. **RideCo** (rideco.com) - On-demand transit software
3. **Liftit** - Logistics dispatch platform
4. **Onfleet** (onfleet.com) - Last-mile delivery/dispatch
5. **Bringg** - Delivery orchestration platform
6. **Circuit** - Route optimization with driver app

## For Each Provider, Find:
1. Do they have a public API for third-party booking integration?
2. Is it designed for passenger transport or just delivery?
3. Can you bring your own drivers?
4. Pricing model (per-trip, monthly, revenue share)?
5. Geographic availability (Miami, FL)?
6. Documentation quality
7. Developer reviews/experiences

## Also Research:
- "Build vs buy dispatch system startup"
- "Driver app white label solutions"
- "Fleet management API for startups"
- Open source dispatch alternatives (OpenTripPlanner, etc.)

## Output:
Comparison table with recommendation for LinkMia's use case (airport transfers, premium vehicles, Miami area, 10-200 trips/week).
```

---

## How to Use These Results

After running both research prompts, create a decision matrix:

| Criteria | Weight | Spare Score | Alternative Score | Build Own Score |
|----------|--------|-------------|-------------------|-----------------|
| Time to launch | 25% | ? | ? | ? |
| API flexibility | 20% | ? | ? | ? |
| Cost (year 1) | 15% | ? | ? | ? |
| Cost (year 2+) | 10% | ? | ? | ? |
| Driver app quality | 15% | ? | ? | ? |
| Customization | 10% | ? | ? | ? |
| Risk level | 5% | ? | ? | ? |

Score 1-5, multiply by weight, highest total wins.

---

## Next Steps After Research

1. **If Spare looks good**: Schedule sales call, request sandbox access
2. **If concerns arise**: Evaluate top alternative from research
3. **If all SaaS options fail**: Plan 12-week build for custom dispatch

Created: 2024
For: LinkMia / AirportMVP dispatch integration decision
