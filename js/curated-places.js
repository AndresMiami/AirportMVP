// Curated cruise terminals — registry validation and query matching.
//
// ONE file for both sides: indexMVP loads it as a classic script (global
// `CuratedPlaces`, read by autocomplete.js), and the Netlify functions
// `require` it (backend/functions/lib/curated-places.js). Browser and server
// therefore share one definition of a valid registry and one label
// format. The registry itself is data/curated-places.json. The browser copy
// drives SUGGESTIONS only; the server copy decides STORED labels.
//
// Pure: no DOM, no network, no clock, no global state. Every returned
// structure is frozen.
//
// MATCHING RULE: a query of >= 3 characters matches a candidate phrase when
// EVERY query token prefix-matches a DISTINCT token of that phrase.
// Direction matters: "virgin" matches the token `virgin`; "virginia" does
// not, because `virgin` does not start with `virginia`. So Virginia Key /
// Virginia Gardens never summon Terminal V, while "virgin", "virgin voya"
// and "virgin voyage" all do. Not fuzzy: misspellings fall through to
// Google exactly as today.
//
// ROWS: a company match ("carnival") yields one row per terminal of that
// company, naming the company. A terminal or port match ("terminal a",
// "portmiami") yields the terminal row naming every company that sails from
// it. A terminal is never listed twice; when two companies sharing a
// terminal both match, the row names them all rather than guessing.
//
// TERMINAL LETTER (Codex relay 0272 #1): PortMiami names its terminals by
// one or two letters (A–J, V, AA). A word of at most MAX_DESIGNATOR_LENGTH
// characters standing right before or right after the word "terminal" (or
// any unfinished prefix of it) is read as that letter and matches ONLY the
// start of a terminal's own letter(s): "terminal a" -> A and AA, "terminal
// aa" -> AA, "terminal c" -> nothing while no verified Terminal C exists
// (Google's rows stand alone). It is never read as the start of another
// word, so "c" cannot reach "cruise" and "d" cannot reach "disney" — the
// defect was "terminal c" listing every terminal and "norwegian terminal c"
// answering B. Longer words next to "terminal" keep ordinary prefix
// completion ("terminal carnival", "msc terminal"), and letters elsewhere
// do too ("norwegian c" is still Norwegian Cruise Line being typed). Every
// terminal record names its letter(s) after the word "terminal" in its name
// or keywords; the validator requires one, bounds its length and keeps it
// unique across terminals.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CuratedPlaces = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_QUERY_LENGTH = 3;
  const TERMINAL_WORD = 'terminal';
  // PortMiami's terminal letters are one or two characters (A–J, V, AA). A
  // registry entry whose letter is longer fails validation rather than
  // silently falling outside the terminal-letter rule.
  const MAX_DESIGNATOR_LENGTH = 2;
  // create-booking / update-pending-booking bound stored labels to 500
  // characters (text(..., 500)); a label the server could never store must
  // never be offered.
  const MAX_LABEL_LENGTH = 500;
  const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,2048}$/;
  const KEY_RE = /^[a-z0-9-]{2,40}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  // The stored label travels through SQL, Telegram and a Google Maps
  // navigation URL: printable ASCII keeps every seam byte-exact.
  const ASCII_RE = /^[\x20-\x7E]+$/;

  // ---------------------------------------------------------------- utils

  function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      Object.keys(value).forEach((key) => deepFreeze(value[key]));
    }
    return value;
  }

  function trimmedString(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim();
  }

  function stringList(value, max) {
    return Array.isArray(value) && value.every((item) => trimmedString(item, max));
  }

  // Lowercase, strip accents, and reduce everything that is not a letter or
  // digit to single spaces, so "Terminal V - Virgin" and "port-miami" tokenize
  // the way a passenger types them.
  function normalize(text) {
    return String(text == null ? '' : text)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function tokensOf(text) {
    const normalized = normalize(text);
    return normalized ? normalized.split(' ') : [];
  }

  function uniqueTokens(phrases) {
    const seen = new Set();
    phrases.forEach((phrase) => tokensOf(phrase).forEach((token) => seen.add(token)));
    return [...seen];
  }

  // "terminal", or the start of it still being typed ("term").
  function isTerminalWord(token) {
    return token.length > 0 && TERMINAL_WORD.startsWith(token);
  }

  // The letter(s) a registry record gives its terminal: every token that
  // directly follows the exact word "terminal" in the phrases ("PortMiami
  // Terminal AA" -> "aa"; "msc terminal" contributes nothing).
  function designatorsIn(phrases) {
    const seen = new Set();
    phrases.forEach((phrase) => {
      const tokens = tokensOf(phrase);
      tokens.forEach((token, index) => {
        if (token === TERMINAL_WORD && index + 1 < tokens.length) seen.add(tokens[index + 1]);
      });
    });
    return [...seen];
  }

  // Splits a normalized query into ordinary tokens and the terminal letters
  // it spells out: a token of at most MAX_DESIGNATOR_LENGTH characters right
  // before or right after a terminal word. The terminal word itself stays an
  // ordinary token (it still has to prefix-match "terminal" in a candidate),
  // and a longer neighbour is an ordinary word ("terminal carnival").
  function parseQuery(normalizedQuery) {
    const tokens = normalizedQuery ? String(normalizedQuery).split(' ') : [];
    const letterAt = new Set();
    tokens.forEach((token, index) => {
      if (!isTerminalWord(token)) return;
      [index - 1, index + 1].forEach((neighbour) => {
        if (neighbour < 0 || neighbour >= tokens.length) return;
        const word = tokens[neighbour];
        if (isTerminalWord(word) || word.length > MAX_DESIGNATOR_LENGTH) return;
        letterAt.add(neighbour);
      });
    });
    return {
      tokens: tokens.filter((token, index) => !letterAt.has(index)),
      designators: tokens.filter((token, index) => letterAt.has(index))
    };
  }

  // Every query token must prefix-match a DISTINCT candidate token. The
  // candidate pools are tiny, so exhaustive assignment is cheap and exact.
  function tokensMatch(queryTokens, candidateTokens) {
    if (queryTokens.length === 0 || queryTokens.length > candidateTokens.length) return false;
    const used = new Array(candidateTokens.length).fill(false);
    function place(index) {
      if (index === queryTokens.length) return true;
      for (let j = 0; j < candidateTokens.length; j++) {
        if (!used[j] && candidateTokens[j].startsWith(queryTokens[index])) {
          used[j] = true;
          if (place(index + 1)) return true;
          used[j] = false;
        }
      }
      return false;
    }
    return place(0);
  }

  // 3 = the query IS one of the phrases, 2 = it prefix-matches one, 0 = no.
  function bestPhraseScore(queryTokens, normalizedQuery, phrases) {
    let best = 0;
    for (const phrase of phrases) {
      const normalizedPhrase = normalize(phrase);
      if (!normalizedPhrase) continue;
      if (normalizedPhrase === normalizedQuery) return 3;
      if (best < 2 && tokensMatch(queryTokens, normalizedPhrase.split(' '))) best = 2;
    }
    return best;
  }

  // ------------------------------------------------------------- registry

  function terminalLabel(terminal) {
    return `${terminal.name}, ${terminal.address}`;
  }

  // Returns { ok, errors, registry }. The registry is null unless ok. An
  // invalid file disables curated features everywhere — bookings keep
  // today's behaviour — rather than shipping a half-trusted list.
  function validateRegistry(raw) {
    const errors = [];
    const fail = (message) => { errors.push(message); };

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, errors: ['registry must be an object'], registry: null };
    }
    if (!Number.isInteger(raw.version) || raw.version < 1) fail('version must be a positive integer');

    const port = raw.port;
    if (!port || typeof port !== 'object' || !trimmedString(port.name, 80) || !stringList(port.keywords, 40)) {
      fail('port must carry a name and a keyword list');
    }

    const companies = [];
    const companyByKey = {};
    if (!Array.isArray(raw.companies) || raw.companies.length === 0) {
      fail('companies must be a non-empty array');
    } else {
      raw.companies.forEach((company, index) => {
        const where = `company[${index}]`;
        if (!company || typeof company !== 'object') return fail(`${where} must be an object`);
        if (typeof company.key !== 'string' || !KEY_RE.test(company.key)) return fail(`${where} key invalid`);
        if (companyByKey[company.key]) return fail(`${where} key duplicated: ${company.key}`);
        if (!trimmedString(company.name, 80)) return fail(`${where} name invalid`);
        if (!stringList(company.keywords, 40)) return fail(`${where} keywords invalid`);
        const entry = { key: company.key, name: company.name, keywords: company.keywords.slice() };
        companies.push(entry);
        companyByKey[company.key] = entry;
      });
    }

    const terminals = [];
    const terminalIds = new Set();
    const placeIds = new Set();
    const designatorOwners = new Map();
    if (!Array.isArray(raw.terminals)) {
      fail('terminals must be an array');
    } else {
      raw.terminals.forEach((terminal, index) => {
        const where = `terminal[${index}]`;
        if (!terminal || typeof terminal !== 'object') return fail(`${where} must be an object`);
        if (typeof terminal.id !== 'string' || !KEY_RE.test(terminal.id)) return fail(`${where} id invalid`);
        if (terminalIds.has(terminal.id)) return fail(`${where} id duplicated: ${terminal.id}`);
        terminalIds.add(terminal.id);
        if (!trimmedString(terminal.name, 120)) return fail(`${where} name invalid`);
        if (!Array.isArray(terminal.companies) || terminal.companies.length === 0 ||
            new Set(terminal.companies).size !== terminal.companies.length ||
            !terminal.companies.every((key) => Object.prototype.hasOwnProperty.call(companyByKey, key))) {
          return fail(`${where} companies must list distinct known company keys`);
        }
        if (!stringList(terminal.keywords, 40)) return fail(`${where} keywords invalid`);
        // One record per PHYSICAL terminal, so its letter(s) are its own:
        // required (the terminal-letter rule can only admit a record that
        // names one), bounded, and never shared with another record.
        const designators = designatorsIn([terminal.name, ...terminal.keywords]);
        if (designators.length === 0) return fail(`${where} must name its terminal letter after the word "terminal" in its name or keywords`);
        const longLetter = designators.find((letter) => letter.length > MAX_DESIGNATOR_LENGTH);
        if (longLetter) return fail(`${where} terminal letter "${longLetter}" exceeds ${MAX_DESIGNATOR_LENGTH} characters`);
        const takenLetter = designators.find((letter) => designatorOwners.has(letter));
        if (takenLetter) return fail(`${where} terminal letter "${takenLetter}" already belongs to ${designatorOwners.get(takenLetter)}`);
        designators.forEach((letter) => designatorOwners.set(letter, terminal.id));
        if (!trimmedString(terminal.source, 1000)) return fail(`${where} source is required`);
        const verifiedAt = terminal.verifiedAt == null ? null : terminal.verifiedAt;
        if (verifiedAt !== null && (typeof verifiedAt !== 'string' || !DATE_RE.test(verifiedAt))) {
          return fail(`${where} verifiedAt must be null or YYYY-MM-DD`);
        }
        const address = terminal.address == null ? null : terminal.address;
        if (address !== null && !trimmedString(address, 200)) return fail(`${where} address invalid`);
        const placeId = terminal.placeId == null ? null : terminal.placeId;
        if (placeId !== null && (typeof placeId !== 'string' || !PLACE_ID_RE.test(placeId))) {
          return fail(`${where} placeId invalid`);
        }
        if (placeId !== null) {
          if (placeIds.has(placeId)) return fail(`${where} placeId duplicated: ${placeId}`);
          placeIds.add(placeId);
        }
        const verified = verifiedAt !== null;
        if (verified) {
          if (address === null) return fail(`${where} is verified but has no address`);
          if (placeId === null) return fail(`${where} is verified but has no placeId`);
          const label = `${terminal.name}, ${address}`;
          if (label.length > MAX_LABEL_LENGTH) return fail(`${where} label exceeds ${MAX_LABEL_LENGTH} characters`);
          if (!ASCII_RE.test(label)) return fail(`${where} label must be printable ASCII`);
        }
        terminals.push({
          id: terminal.id,
          name: terminal.name,
          address,
          placeId,
          companies: terminal.companies.slice(),
          keywords: terminal.keywords.slice(),
          designators,
          source: terminal.source,
          verifiedAt,
          verified
        });
      });
    }

    if (errors.length > 0) return { ok: false, errors, registry: null };

    const verified = terminals.filter((terminal) => terminal.verified);
    const byPlaceId = {};
    verified.forEach((terminal) => { byPlaceId[terminal.placeId] = terminal; });

    return {
      ok: true,
      errors: [],
      registry: deepFreeze({
        version: raw.version,
        port: { name: port.name, keywords: port.keywords.slice() },
        companies,
        companyByKey,
        terminals,
        verified,
        byPlaceId
      })
    };
  }

  function findVerifiedByPlaceId(registry, placeId) {
    if (!registry || typeof placeId !== 'string') return null;
    return Object.prototype.hasOwnProperty.call(registry.byPlaceId, placeId) ? registry.byPlaceId[placeId] : null;
  }

  // ------------------------------------------------------------- matching

  function toRow(row, registry) {
    const { terminal, company, kind, score } = row;
    const companyNames = terminal.companies.map((key) => registry.companyByKey[key].name);
    return deepFreeze({
      terminalId: terminal.id,
      placeId: terminal.placeId,
      kind: company ? kind : 'terminal',
      companyKey: company ? company.key : null,
      title: company ? `${company.name} — ${terminal.name}` : `${terminal.name} — ${companyNames.join(', ')}`,
      subtitle: terminal.address,
      label: terminalLabel(terminal),
      score
    });
  }

  // ONE row shape for every curated selection (terminal confirmation R1,
  // plan §3.2): the dropdown builds its rows through toRow above, and the
  // confirm sheet — a list of terminals with no company context — asks for
  // the same shape by terminal id, companyKey null. Both entry points then
  // run the autocomplete's one selection path and cannot drift.
  function terminalRow(registry, terminalId) {
    if (!registry || !Array.isArray(registry.verified) || typeof terminalId !== 'string') return null;
    const terminal = registry.verified.find((entry) => entry.id === terminalId);
    if (!terminal) return null;
    return toRow({ terminal, company: null, kind: 'terminal', score: 0 }, registry);
  }

  function matchCurated(query, registry) {
    if (!registry || !Array.isArray(registry.verified) || registry.verified.length === 0) return [];
    const normalizedQuery = normalize(query);
    if (normalizedQuery.length < MIN_QUERY_LENGTH) return [];
    const { tokens: queryTokens, designators } = parseQuery(normalizedQuery);
    // A spelled-out terminal letter admits only the terminals whose own
    // letter(s) start with it. With none admitted LinkMia offers nothing and
    // Google's rows stand alone — never another terminal.
    const eligible = registry.verified.filter((terminal) =>
      designators.every((letter) => Array.isArray(terminal.designators)
        && terminal.designators.some((own) => own.startsWith(letter))));
    if (eligible.length === 0) return [];
    const rows = new Map();
    const position = (terminal) => registry.verified.indexOf(terminal);

    function offer(terminal, company, kind, score) {
      const existing = rows.get(terminal.id);
      if (!existing) {
        rows.set(terminal.id, { terminal, company, kind, score });
        return;
      }
      if (score > existing.score) existing.score = score;
      // Two different companies matched the same terminal, or a terminal /
      // port match arrived for a shared terminal: name every company, never
      // pick one.
      const shared = terminal.companies.length > 1;
      if ((company && existing.company && existing.company.key !== company.key) || (!company && shared)) {
        existing.company = null;
        existing.kind = 'terminal';
      }
    }

    // 1. Company-driven: "carnival" -> every Carnival terminal.
    registry.companies.forEach((company) => {
      const score = bestPhraseScore(queryTokens, normalizedQuery, [company.name, ...company.keywords]);
      if (!score) return;
      eligible
        .filter((terminal) => terminal.companies.includes(company.key))
        .forEach((terminal) => offer(terminal, company, 'company', score));
    });

    // 2. Terminal- or port-driven: "terminal a", "portmiami" -> the terminal
    //    row, naming its companies.
    const portPhrases = [registry.port.name, ...registry.port.keywords];
    eligible.forEach((terminal) => {
      const score = bestPhraseScore(queryTokens, normalizedQuery, [terminal.name, ...terminal.keywords, ...portPhrases]);
      if (score) offer(terminal, null, 'terminal', score);
    });

    // 3. Mixed wording ("virgin terminal", "carnival terminal d"): company
    //    words plus terminal words in one query, for terminals not yet matched.
    eligible.forEach((terminal) => {
      if (rows.has(terminal.id)) return;
      terminal.companies.forEach((key) => {
        const company = registry.companyByKey[key];
        const pool = uniqueTokens([company.name, ...company.keywords, terminal.name, ...terminal.keywords, ...portPhrases]);
        if (tokensMatch(queryTokens, pool)) offer(terminal, company, 'combined', 1);
      });
    });

    return deepFreeze([...rows.values()]
      .sort((a, b) => (b.score - a.score) || (position(a.terminal) - position(b.terminal)))
      .map((row) => toRow(row, registry)));
  }

  return {
    MIN_QUERY_LENGTH,
    MAX_LABEL_LENGTH,
    MAX_DESIGNATOR_LENGTH,
    normalize,
    tokensMatch,
    parseQuery,
    validateRegistry,
    findVerifiedByPlaceId,
    terminalLabel,
    terminalRow,
    matchCurated
  };
}));
