// Curated cruise terminals — registry schema, ranking and coverage.
//
// Run: node tests/curated-places-registry.test.js
//
// Field evidence (LM-EFFA, 2026-10-26): Google's live predictions for
// "Virgin" were five Virginia places and NO Virgin Voyages result at all;
// "Virgin voyage" ranked the generic brand result (whose Place Details
// address is literally "Miami, FL 33132, USA" — the label LM-EFFA stored)
// and the Plantation corporate office above Terminal V. Reordering Google's
// list can never fix that; the app needs its own verified terminals
// inserted above it. This suite pins the matcher that does the inserting
// and the registry that feeds it.
//
// PR_COMPLETE: the PR is not complete until all seven supported companies
// have verified terminal choices. The registry-completion commit (Andres's
// confirmations, 2026-10-27) flipped this to true: the coverage section now
// ASSERTS that every supported company has a verified terminal.
const PR_COMPLETE = true;

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const core = require('../js/curated-places.js');
const serverSide = require('../backend/functions/lib/curated-places.js');
const realRaw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/curated-places.json'), 'utf8'));

const REQUIRED_COMPANIES = ['virgin', 'carnival', 'royal-caribbean', 'norwegian', 'celebrity', 'msc', 'disney'];
const TERMINAL_V_PLACE_ID = 'ChIJO1Q7bLK12YgRyjFe2sYTfNc';
const TERMINAL_V_LABEL = 'PortMiami Terminal V, 718 N Cruise Blvd, Miami, FL 33132';

// A fixture independent of which real entries are verified today: one
// single-company terminal, one SHARED terminal, a three-terminal company and
// an inert draft.
function fixtureRaw() {
  return {
    version: 1,
    port: { name: 'PortMiami', keywords: ['portmiami', 'port miami', 'cruise port'] },
    companies: [
      { key: 'virgin', name: 'Virgin Voyages', keywords: ['virgin', 'virgin voyages', 'virgin voyage'] },
      { key: 'carnival', name: 'Carnival Cruise Line', keywords: ['carnival'] },
      { key: 'royal-caribbean', name: 'Royal Caribbean', keywords: ['royal', 'royal caribbean'] },
      { key: 'celebrity', name: 'Celebrity Cruises', keywords: ['celebrity'] },
      { key: 'norwegian', name: 'Norwegian Cruise Line', keywords: ['norwegian', 'ncl'] }
    ],
    terminals: [
      { id: 'pom-terminal-v', name: 'PortMiami Terminal V', address: '718 N Cruise Blvd, Miami, FL 33132',
        placeId: TERMINAL_V_PLACE_ID, companies: ['virgin'], keywords: ['terminal v'], source: 'fixture', verifiedAt: '2026-10-26' },
      { id: 'pom-terminal-a', name: 'PortMiami Terminal A', address: '1 Terminal A Way, Miami, FL 33132',
        placeId: 'ChIJfixtureTerminalA000', companies: ['royal-caribbean', 'celebrity'], keywords: ['terminal a'], source: 'fixture', verifiedAt: '2026-10-26' },
      { id: 'pom-terminal-d', name: 'PortMiami Terminal D', address: '1 Terminal D Way, Miami, FL 33132',
        placeId: 'ChIJfixtureTerminalD000', companies: ['carnival'], keywords: ['terminal d'], source: 'fixture', verifiedAt: '2026-10-26' },
      { id: 'pom-terminal-e', name: 'PortMiami Terminal E', address: '1 Terminal E Way, Miami, FL 33132',
        placeId: 'ChIJfixtureTerminalE000', companies: ['carnival'], keywords: ['terminal e'], source: 'fixture', verifiedAt: '2026-10-26' },
      { id: 'pom-terminal-f', name: 'PortMiami Terminal F', address: '1 Terminal F Way, Miami, FL 33132',
        placeId: 'ChIJfixtureTerminalF000', companies: ['carnival'], keywords: ['terminal f'], source: 'fixture', verifiedAt: '2026-10-26' },
      { id: 'pom-terminal-b', name: 'PortMiami Terminal B', address: null,
        placeId: null, companies: ['norwegian'], keywords: ['terminal b'], source: 'fixture draft', verifiedAt: null }
    ]
  };
}

const fixture = core.validateRegistry(fixtureRaw()).registry;
const match = (query) => core.matchCurated(query, fixture);
const ids = (rows) => rows.map((row) => row.terminalId);

let passed = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${name}`);
  } catch (error) {
    results.push(`  ✗ ${name}\n      ${error.message}`);
    results.forEach((line) => console.log(line));
    console.log(`\nFAILED at: ${name}`);
    process.exit(1);
  }
}

(async () => {
  console.log('\nCurated cruise terminals — registry, ranking, coverage\n');

  // ---------------------------------------------------------- the fixture

  await check('the fixture validates', () => {
    const result = core.validateRegistry(fixtureRaw());
    assert.strictEqual(result.ok, true, result.errors.join('; '));
    assert.strictEqual(result.registry.verified.length, 5);
    assert.strictEqual(result.registry.terminals.length, 6);
    assert.ok(Object.isFrozen(result.registry.verified));
  });

  // -------------------------------------------------- Virgin (LM-EFFA)

  for (const query of ['Virgin', 'virgin', 'VIRGIN', 'Virgin voya', 'Virgin voyage', 'Virgin Voyages', 'virgin  voyages ']) {
    await check(`"${query}" puts Virgin Voyages — PortMiami Terminal V first`, () => {
      const rows = match(query);
      assert.ok(rows.length >= 1, 'no curated rows');
      assert.strictEqual(rows[0].terminalId, 'pom-terminal-v');
      assert.strictEqual(rows[0].companyKey, 'virgin');
      assert.strictEqual(rows[0].title, 'Virgin Voyages — PortMiami Terminal V');
      assert.strictEqual(rows[0].subtitle, '718 N Cruise Blvd, Miami, FL 33132');
      assert.strictEqual(rows[0].label, TERMINAL_V_LABEL);
      assert.strictEqual(rows[0].placeId, TERMINAL_V_PLACE_ID);
    });
  }

  await check('an exact company name or keyword scores above a prefix still being typed', () => {
    assert.strictEqual(match('Virgin Voyages')[0].score, 3, 'exact company name');
    assert.strictEqual(match('Virgin')[0].score, 3, '"virgin" is itself a keyword');
    assert.strictEqual(match('Virgin voya')[0].score, 2, 'prefix of a keyword');
    assert.strictEqual(match('Vir')[0].score, 2, 'prefix of a keyword');
  });

  for (const query of ['Virginia', 'virginia key', 'Virginia Gardens', 'Virginia Beach']) {
    await check(`"${query}" never summons Terminal V (direction of the prefix rule)`, () => {
      assert.deepStrictEqual(match(query), []);
    });
  }

  await check('"Vir" shows Terminal V while the passenger is still typing "Virgin"', () => {
    assert.strictEqual(match('Vir')[0].terminalId, 'pom-terminal-v');
  });

  await check('Plantation / generic wording never maps to a terminal through the matcher', () => {
    // These are Google's rows; the matcher must stay silent so nothing of
    // ours is attached to them.
    assert.deepStrictEqual(match('South Pine Island Road'), []);
    assert.deepStrictEqual(match('Plantation'), []);
    assert.deepStrictEqual(match('Miami, FL 33132'), []);
  });

  // ------------------------------------------------- the other companies

  await check('"carnival" lists every Carnival terminal, in registry order, naming the company', () => {
    const rows = match('carnival');
    assert.deepStrictEqual(ids(rows), ['pom-terminal-d', 'pom-terminal-e', 'pom-terminal-f']);
    rows.forEach((row) => {
      assert.strictEqual(row.companyKey, 'carnival');
      assert.strictEqual(row.kind, 'company');
      assert.match(row.title, /^Carnival Cruise Line — PortMiami Terminal [DEF]$/);
    });
  });

  await check('"royal" and "celebrity" each find the shared Terminal A once, naming the company typed', () => {
    const royal = match('royal');
    assert.deepStrictEqual(ids(royal), ['pom-terminal-a']);
    assert.strictEqual(royal[0].title, 'Royal Caribbean — PortMiami Terminal A');
    const celebrity = match('celebrity');
    assert.deepStrictEqual(ids(celebrity), ['pom-terminal-a']);
    assert.strictEqual(celebrity[0].title, 'Celebrity Cruises — PortMiami Terminal A');
  });

  await check('"terminal a" shows the shared terminal ONCE and names both companies — no guessing', () => {
    const rows = match('terminal a');
    assert.deepStrictEqual(ids(rows), ['pom-terminal-a']);
    assert.strictEqual(rows[0].companyKey, null);
    assert.strictEqual(rows[0].kind, 'terminal');
    assert.strictEqual(rows[0].title, 'PortMiami Terminal A — Royal Caribbean, Celebrity Cruises');
  });

  await check('a generic query that reaches a shared terminal through one company still names every company', () => {
    // "cruise" matches Celebrity Cruises by name (a company row for Terminal
    // A) and then the port keyword "cruise port" (a terminal row for every
    // terminal). The shared terminal must end up naming both companies.
    const rows = match('cruise');
    const terminalA = rows.find((row) => row.terminalId === 'pom-terminal-a');
    assert.ok(terminalA, 'Terminal A present for "cruise"');
    assert.strictEqual(terminalA.companyKey, null, 'shared terminal names every company for a generic query');
  });

  for (const query of ['portmiami', 'Port Miami', 'cruise port', 'PortMiami']) {
    await check(`"${query}" lists every verified terminal once, in registry order`, () => {
      const rows = match(query);
      assert.deepStrictEqual(ids(rows), ['pom-terminal-v', 'pom-terminal-a', 'pom-terminal-d', 'pom-terminal-e', 'pom-terminal-f']);
      assert.strictEqual(new Set(ids(rows)).size, rows.length);
    });
  }

  await check('mixed wording: "virgin terminal" and "carnival terminal d" resolve to the one terminal meant', () => {
    assert.deepStrictEqual(ids(match('virgin terminal')), ['pom-terminal-v']);
    assert.deepStrictEqual(ids(match('carnival terminal d')), ['pom-terminal-d']);
    assert.strictEqual(match('carnival terminal d')[0].companyKey, 'carnival');
  });

  // ------------------------------------------------ the terminal letter
  // Codex relay 0272 #1 (at bc736c8): "terminal c" listed every terminal
  // because a lone "c" prefix-matched "cruise", "terminal d" added Disney's
  // Terminal F through "disney", and "norwegian terminal c" answered B.

  await check('a letter next to the word "terminal" is the terminal letter: "terminal c" and "c terminal" find nothing (no verified Terminal C)', () => {
    for (const query of ['terminal c', 'c terminal', 'Terminal C', 'terminal ca', 'te c', 'term c', 'cruise terminal c']) {
      assert.deepStrictEqual(match(query), [], query);
    }
  });

  await check('a terminal letter beside a company name narrows to that letter, never to the company\'s other terminals', () => {
    assert.deepStrictEqual(ids(match('celebrity terminal c')), [], '"celebrity terminal c": Celebrity sails from A here, not C');
    assert.deepStrictEqual(ids(match('carnival terminal c')), [], '"carnival terminal c": Carnival has D/E/F, not C');
    assert.deepStrictEqual(ids(match('carnival terminal e')), ['pom-terminal-e']);
    assert.deepStrictEqual(ids(match('carnival e terminal')), ['pom-terminal-e']);
    assert.deepStrictEqual(ids(match('terminal d')), ['pom-terminal-d']);
    assert.deepStrictEqual(ids(match('d terminal')), ['pom-terminal-d']);
    assert.deepStrictEqual(ids(match('a terminal')), ['pom-terminal-a']);
  });

  await check('letters elsewhere, and longer words next to "terminal", keep ordinary prefix completion', () => {
    assert.deepStrictEqual(ids(match('celebrity c')), ['pom-terminal-a'], '"celebrity c" is Celebrity Cruises being typed');
    assert.deepStrictEqual(ids(match('virgin v')), ['pom-terminal-v'], '"virgin v" is Virgin Voyages being typed');
    assert.deepStrictEqual(ids(match('terminal carnival')), ['pom-terminal-d', 'pom-terminal-e', 'pom-terminal-f']);
    assert.deepStrictEqual(ids(match('carnival terminal')), ['pom-terminal-d', 'pom-terminal-e', 'pom-terminal-f']);
    assert.deepStrictEqual(ids(match('terminal')), ['pom-terminal-v', 'pom-terminal-a', 'pom-terminal-d', 'pom-terminal-e', 'pom-terminal-f'], 'the bare word still lists every terminal');
  });

  await check('parseQuery: the letter is a token of at most two characters beside a (possibly unfinished) terminal word', () => {
    assert.strictEqual(core.MAX_DESIGNATOR_LENGTH, 2);
    assert.deepStrictEqual(core.parseQuery('norwegian terminal c'), { tokens: ['norwegian', 'terminal'], designators: ['c'] });
    assert.deepStrictEqual(core.parseQuery('c terminal'), { tokens: ['terminal'], designators: ['c'] });
    assert.deepStrictEqual(core.parseQuery('terminal aa'), { tokens: ['terminal'], designators: ['aa'] });
    assert.deepStrictEqual(core.parseQuery('te c'), { tokens: ['te'], designators: ['c'] });
    assert.deepStrictEqual(core.parseQuery('msc terminal'), { tokens: ['msc', 'terminal'], designators: [] });
    assert.deepStrictEqual(core.parseQuery('terminal carnival'), { tokens: ['terminal', 'carnival'], designators: [] });
    assert.deepStrictEqual(core.parseQuery('terminal'), { tokens: ['terminal'], designators: [] });
    assert.deepStrictEqual(core.parseQuery('celebrity c'), { tokens: ['celebrity', 'c'], designators: [] });
    assert.deepStrictEqual(core.parseQuery(''), { tokens: [], designators: [] });
  });

  await check('a draft (no verifiedAt) is inert: "norwegian", "ncl" and "terminal b" find nothing', () => {
    assert.deepStrictEqual(match('norwegian'), []);
    assert.deepStrictEqual(match('ncl'), []);
    assert.deepStrictEqual(match('terminal b'), []);
    assert.strictEqual(core.findVerifiedByPlaceId(fixture, null), null);
  });

  await check('queries under 3 characters, blank, or non-string yield nothing', () => {
    for (const query of ['', ' ', 'vi', 'V', null, undefined, 42, {}]) {
      assert.deepStrictEqual(core.matchCurated(query, fixture), []);
    }
    assert.deepStrictEqual(core.matchCurated('virgin', null), []);
    assert.deepStrictEqual(core.matchCurated('virgin', { verified: [] }), []);
  });

  await check('no query ever lists a terminal twice, and rows are sorted by score then registry order', () => {
    for (const query of ['virgin', 'carnival', 'cruise', 'terminal', 'port miami', 'royal caribbean', 'terminal a']) {
      const rows = match(query);
      assert.strictEqual(new Set(ids(rows)).size, rows.length, `duplicate terminal for "${query}"`);
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1].score >= rows[i].score, `score order broken for "${query}"`);
      }
    }
  });

  await check('results and the registry are frozen (a consumer cannot mutate a row into another place)', () => {
    const rows = match('virgin');
    assert.ok(Object.isFrozen(rows) && Object.isFrozen(rows[0]));
    assert.throws(() => { 'use strict'; rows[0].placeId = 'ChIJsomethingElse000'; });
  });

  await check('the matching rule itself: every query token prefix-matches a DISTINCT candidate token', () => {
    assert.strictEqual(core.tokensMatch(['virgin'], ['virgin', 'voyages']), true);
    assert.strictEqual(core.tokensMatch(['virginia'], ['virgin', 'voyages']), false);
    assert.strictEqual(core.tokensMatch(['virgin', 'voyage'], ['virgin', 'voyages']), true);
    assert.strictEqual(core.tokensMatch(['virgin', 'virgin'], ['virgin', 'voyages']), false, 'distinct tokens');
    assert.strictEqual(core.tokensMatch(['v', 'terminal'], ['terminal', 'v']), true, 'order-free');
    assert.strictEqual(core.tokensMatch([], ['virgin']), false);
    assert.strictEqual(core.normalize('  Términal V — Virgin! '), 'terminal v virgin');
  });

  // ------------------------------------------------------- schema guards

  const reject = (mutate, reason) => {
    const raw = fixtureRaw();
    mutate(raw);
    const result = core.validateRegistry(raw);
    assert.strictEqual(result.ok, false, `expected rejection: ${reason}`);
    assert.strictEqual(result.registry, null);
    assert.ok(result.errors.length > 0);
  };

  await check('schema: a verified terminal must carry an address and a placeId', () => {
    reject((raw) => { raw.terminals[0].placeId = null; }, 'verified without placeId');
    reject((raw) => { raw.terminals[0].address = null; }, 'verified without address');
  });

  await check('schema: place IDs are unique and well-formed; ids and company keys are unique and known', () => {
    reject((raw) => { raw.terminals[2].placeId = TERMINAL_V_PLACE_ID; }, 'duplicate placeId');
    reject((raw) => { raw.terminals[0].placeId = 'not a place id!'; }, 'malformed placeId');
    reject((raw) => { raw.terminals[1].id = 'pom-terminal-v'; }, 'duplicate terminal id');
    reject((raw) => { raw.terminals[0].companies = ['unknown-line']; }, 'unknown company key');
    reject((raw) => { raw.terminals[0].companies = ['virgin', 'virgin']; }, 'repeated company key');
    reject((raw) => { raw.companies.push({ key: 'virgin', name: 'Dup', keywords: [] }); }, 'duplicate company key');
  });

  await check('schema: verifiedAt is null or YYYY-MM-DD; labels fit the 500-char ASCII store bound', () => {
    reject((raw) => { raw.terminals[0].verifiedAt = 'yesterday'; }, 'bad verifiedAt');
    reject((raw) => { raw.terminals[0].address = 'x'.repeat(200); raw.terminals[0].name = 'y'.repeat(120); raw.terminals[0].address = 'z'.repeat(200) + 'q'.repeat(200); }, 'address too long');
    reject((raw) => { raw.terminals[0].address = '718 N Cruise Blvd, Miami, FL 33132 — muelle'; }, 'non-ASCII label');
    reject((raw) => { raw.terminals[0].source = ''; }, 'missing source');
    reject((raw) => { delete raw.port; }, 'missing port');
    reject((raw) => { raw.version = 0; }, 'bad version');
  });

  await check('schema: every terminal names its letter after the word "terminal"; letters are short and unique', () => {
    reject((raw) => { raw.terminals[0].name = 'PortMiami Pier V'; raw.terminals[0].keywords = ['pier v']; }, 'no terminal letter');
    reject((raw) => { raw.terminals[0].keywords = ['terminal v', 'terminal aaa']; }, 'a letter longer than two characters');
    reject((raw) => { raw.terminals[2].keywords = ['terminal d', 'terminal v']; }, 'a letter already owned by another terminal');
    const result = core.validateRegistry(fixtureRaw());
    assert.deepStrictEqual(result.registry.terminals.map((terminal) => terminal.designators), [['v'], ['a'], ['d'], ['e'], ['f'], ['b']]);
  });

  // ----------------------------------------------------- the real file

  await check('data/curated-places.json validates, on the browser side and the server side alike', () => {
    const result = core.validateRegistry(realRaw);
    assert.strictEqual(result.ok, true, result.errors.join('; '));
    assert.strictEqual(serverSide.validation.ok, true, serverSide.validation.errors.join('; '));
    assert.ok(serverSide.registry(), 'server registry loaded');
  });

  await check('the real file lists exactly the seven supported companies', () => {
    const keys = realRaw.companies.map((company) => company.key);
    assert.deepStrictEqual(keys, REQUIRED_COMPANIES);
  });

  await check('Terminal V is verified with the LM-EFFA address and the resolved place ID', () => {
    const terminal = serverSide.findVerifiedTerminal(TERMINAL_V_PLACE_ID);
    assert.ok(terminal, 'Terminal V verified in the real registry');
    assert.strictEqual(terminal.id, 'pom-terminal-v');
    assert.deepStrictEqual(terminal.companies, ['virgin']);
    assert.strictEqual(core.terminalLabel(terminal), TERMINAL_V_LABEL);
    const real = core.validateRegistry(realRaw).registry;
    assert.strictEqual(core.matchCurated('Virgin', real)[0].terminalId, 'pom-terminal-v');
    assert.strictEqual(core.matchCurated('Virgin voyage', real)[0].label, TERMINAL_V_LABEL);
  });

  await check('real registry: each company query names the company first; a terminal query on a shared terminal names both companies', () => {
    const real = core.validateRegistry(realRaw).registry;
    const disney = core.matchCurated('Disney', real);
    assert.deepStrictEqual(disney.map((r) => r.title), ['Disney Cruise Line — PortMiami Terminal F']);
    const carnival = core.matchCurated('Carnival', real);
    assert.deepStrictEqual(carnival.map((r) => r.terminalId), ['pom-terminal-d', 'pom-terminal-e', 'pom-terminal-f']);
    assert.ok(carnival.every((r) => r.title.startsWith('Carnival Cruise Line — ')));
    for (const [query, id] of [['Royal', 'pom-terminal-a'], ['Norwegian', 'pom-terminal-b'], ['Celebrity', 'pom-terminal-g'], ['MSC', 'pom-terminal-aa']]) {
      const rows = core.matchCurated(query, real);
      assert.deepStrictEqual(rows.map((r) => r.terminalId), [id], query);
      assert.strictEqual(rows[0].kind, 'company', `${query} is a company row`);
    }
    const f = core.matchCurated('Terminal F', real);
    assert.deepStrictEqual(f.map((r) => r.title), ['PortMiami Terminal F — Carnival Cruise Line, Disney Cruise Line']);
    assert.deepStrictEqual(core.matchCurated('Virginia', real), []);
  });

  const realLetters = (query) => core.matchCurated(query, core.validateRegistry(realRaw).registry)
    .map((row) => row.terminalId.replace('pom-terminal-', ''));

  await check('real registry: an explicit terminal letter never promotes another terminal (Codex relay 0272 #1)', () => {
    // Codex's four reproductions at bc736c8 answered V A B D E F G AA / D F / B / A.
    assert.deepStrictEqual(realLetters('terminal c'), []);
    assert.deepStrictEqual(realLetters('terminal d'), ['d']);
    assert.deepStrictEqual(realLetters('Norwegian terminal c'), []);
    assert.deepStrictEqual(realLetters('Royal Caribbean terminal c'), []);
    // The same defect in the other word order and with an unfinished word.
    assert.deepStrictEqual(realLetters('c terminal'), []);
    assert.deepStrictEqual(realLetters('norwegian c terminal'), []);
    assert.deepStrictEqual(realLetters('d terminal'), ['d']);
    assert.deepStrictEqual(realLetters('term c'), []);
    for (const query of ['terminal h', 'terminal j', 'terminal aaa']) assert.deepStrictEqual(realLetters(query), [], query);
    // Accepted behaviour preserved.
    assert.deepStrictEqual(realLetters('terminal a'), ['a', 'aa'], '"terminal a": the exact phrase first, then AA');
    assert.deepStrictEqual(realLetters('a terminal'), ['a', 'aa']);
    assert.deepStrictEqual(realLetters('terminal aa'), ['aa']);
    assert.deepStrictEqual(realLetters('msc terminal'), ['aa']);
    assert.deepStrictEqual(realLetters('terminal msc'), ['aa']);
    assert.deepStrictEqual(realLetters('carnival terminal d'), ['d']);
    assert.deepStrictEqual(realLetters('cruise terminal v'), ['v']);
    assert.deepStrictEqual(realLetters('portmiami terminal v'), ['v']);
    assert.deepStrictEqual(realLetters('norwegian c'), ['b'], 'a letter away from the word "terminal" is still a word being typed');
    assert.deepStrictEqual(realLetters('disney c'), ['f']);
    assert.deepStrictEqual(realLetters('terminal dis'), ['f']);
    assert.deepStrictEqual(realLetters('cruise terminal'), ['v', 'a', 'b', 'd', 'e', 'f', 'g', 'aa']);
    const real = core.validateRegistry(realRaw).registry;
    assert.deepStrictEqual(real.verified.map((terminal) => terminal.designators.join('')), ['v', 'a', 'b', 'd', 'e', 'f', 'g', 'aa']);
  });

  await check('real registry: full names, plural forms and initials of the supported companies reach their terminals (Codex relay 0272 #2)', () => {
    const real = core.validateRegistry(realRaw).registry;
    for (const query of ['Royal Caribbean International', 'RCI', 'RCL', 'RCCL', 'royal caribbean cruises', 'royal caribbean cruise']) {
      assert.deepStrictEqual(realLetters(query), ['a'], query);
      assert.strictEqual(core.matchCurated(query, real)[0].companyKey, 'royal-caribbean', query);
    }
    for (const query of ['carnival cruises', 'carnival cruise lines', 'CCL']) assert.deepStrictEqual(realLetters(query), ['d', 'e', 'f'], query);
    for (const query of ['norwegian cruises', 'norwegian cruise lines']) assert.deepStrictEqual(realLetters(query), ['b'], query);
    for (const query of ['disney cruises', 'disney cruise lines']) assert.deepStrictEqual(realLetters(query), ['f'], query);
    assert.deepStrictEqual(realLetters('virgin cruises'), ['v']);
    assert.deepStrictEqual(realLetters('celebrity cruises'), ['g']);
    assert.deepStrictEqual(realLetters('msc cruises'), ['aa']);
  });

  await check('server projection: verified terminal + booking mode -> the address-side column and the label', () => {
    assert.deepStrictEqual(serverSide.projectCuratedLabel(TERMINAL_V_PLACE_ID, 'dropoff'),
      { column: 'pickup_location', label: TERMINAL_V_LABEL, terminalId: 'pom-terminal-v' });
    assert.deepStrictEqual(serverSide.projectCuratedLabel(TERMINAL_V_PLACE_ID, 'pickup'),
      { column: 'dropoff_location', label: TERMINAL_V_LABEL, terminalId: 'pom-terminal-v' });
    assert.strictEqual(serverSide.projectCuratedLabel(TERMINAL_V_PLACE_ID, 'sideways'), null);
    assert.strictEqual(serverSide.projectCuratedLabel('ChIJh8T1SwC12YgRCr9Mz-5L6MA', 'dropoff'), null, 'the generic Virgin Voyages brand result is NOT a terminal');
    assert.strictEqual(serverSide.projectCuratedLabel(null, 'dropoff'), null);
    assert.strictEqual(serverSide.projectCuratedLabel(undefined, 'pickup'), null);
  });

  await check('every verified real terminal has a storable ASCII label and a unique place ID', () => {
    const real = core.validateRegistry(realRaw).registry;
    const seen = new Set();
    real.verified.forEach((terminal) => {
      const label = core.terminalLabel(terminal);
      assert.ok(label.length <= core.MAX_LABEL_LENGTH);
      assert.match(label, /^[\x20-\x7E]+$/);
      assert.ok(!seen.has(terminal.placeId));
      seen.add(terminal.placeId);
    });
  });

  await check(`coverage: every supported company has at least one VERIFIED terminal (${PR_COMPLETE ? 'ASSERTED' : 'reported only until the registry-completion commit'})`, () => {
    const real = core.validateRegistry(realRaw).registry;
    const lines = [];
    const missing = [];
    REQUIRED_COMPANIES.forEach((key) => {
      const verified = real.verified.filter((terminal) => terminal.companies.includes(key)).map((terminal) => terminal.name);
      const drafts = real.terminals.filter((terminal) => !terminal.verified && terminal.companies.includes(key)).map((terminal) => terminal.name);
      lines.push(`      ${real.companyByKey[key].name}: ${verified.length ? verified.join(', ') : 'NO VERIFIED TERMINAL'}${drafts.length ? ` (drafts: ${drafts.join(', ')})` : ''}`);
      if (verified.length === 0) missing.push(key);
    });
    results.push(lines.join('\n'));
    if (PR_COMPLETE) assert.deepStrictEqual(missing, [], `companies without a verified terminal: ${missing.join(', ')}`);
  });

  results.forEach((line) => console.log(line));
  // CI (.github/workflows/tests.yml) accepts a suite only on this exact
  // sentinel; it is printed only after every check above passed.
  console.log(`\n  ALL ${passed} CHECKS PASS\n`);
})();
