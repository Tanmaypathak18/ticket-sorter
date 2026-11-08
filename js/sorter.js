// All sorting logic. No browser-only code, so this runs in the page and in Node.

const OTHER = 'other';
const WORD_CHAR = '[\\p{L}\\p{N}]';
const DAY_MS = 24 * 60 * 60 * 1000;
const REPEAT_DAYS = 7;
const CHANGE_POINTS = 5;
const WEEKLY_MAX_DAYS = 120;
const MONTHLY_MAX_DAYS = 3 * 366;
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function normalizeApostrophes(text) {
  return text.replace(/[‘’]/g, "'");
}

// Whole words only: no letter or digit may touch the word on either side.
function wordPattern(word) {
  const escaped = normalizeApostrophes(word)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`, 'iu');
}

function compileList(words) {
  return [...new Set(words)].map((word) => ({ word, pattern: wordPattern(word) }));
}

function matchedWords(text, list) {
  return list.filter(({ pattern }) => pattern.test(text)).map(({ word }) => word);
}

export function compileRules(rules) {
  return {
    problems: rules.order.map((id) => ({ id, words: compileList(rules.categories[id]) })),
    flags: Object.entries(rules.flags).map(([id, words]) => ({ id, words: compileList(words) })),
  };
}

export function sortTicket(text, compiled) {
  const clean = normalizeApostrophes(String(text ?? ''));

  // Strictly higher score to replace, so ties stay with the problem listed first.
  let problem = OTHER;
  let words = [];
  for (const { id, words: list } of compiled.problems) {
    const found = matchedWords(clean, list);
    if (found.length > words.length) {
      problem = id;
      words = found;
    }
  }

  const flags = {};
  for (const { id, words: list } of compiled.flags) {
    flags[id] = matchedWords(clean, list).length > 0;
  }

  return { problem, words, flags };
}

// Splits text into parts, with hit true on the parts that match the words.
export function highlightParts(text, words) {
  const original = String(text ?? '');
  const clean = normalizeApostrophes(original);
  const ranges = words
    .flatMap((word) => [...clean.matchAll(new RegExp(wordPattern(word).source, 'giu'))])
    .map((match) => [match.index, match.index + match[0].length])
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  const parts = [];
  let position = 0;
  for (const [start, end] of ranges) {
    if (end <= position) continue;
    const from = Math.max(start, position);
    if (from > position) parts.push({ text: original.slice(position, from), hit: false });
    parts.push({ text: original.slice(from, end), hit: true });
    position = end;
  }
  if (position < original.length) parts.push({ text: original.slice(position), hit: false });
  return parts;
}

export function summarize(results) {
  const problems = {};
  const flags = {};
  for (const { problem, flags: ticketFlags } of results) {
    problems[problem] = (problems[problem] ?? 0) + 1;
    for (const [id, isOn] of Object.entries(ticketFlags)) {
      flags[id] = (flags[id] ?? 0) + (isOn ? 1 : 0);
    }
  }
  return { total: results.length, problems, flags };
}

function utcDate(year, month, day) {
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? ms : null;
}

function monthNumber(name) {
  const clean = name.toLowerCase();
  if (clean.length < 3) return 0;
  return MONTHS.findIndex((month) => month.startsWith(clean)) + 1;
}

// Returns whole days as UTC milliseconds, or null when the date can't be read.
export function parseDate(value) {
  const text = String(value ?? '').trim();
  let match;

  // 2026-03-31, with or without a time after it
  if ((match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) {
    return utcDate(+match[1], +match[2], +match[3]);
  }
  // 03/31/2026 or 3/31/26. Month comes first unless that can't be a month.
  if ((match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?:\s.*)?$/))) {
    const year = match[3].length === 2 ? 2000 + +match[3] : +match[3];
    const [month, day] = +match[1] > 12 ? [+match[2], +match[1]] : [+match[1], +match[2]];
    return utcDate(year, month, day);
  }
  // Mar 31, 2026 or March 31 2026
  if ((match = text.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/i))) {
    const month = monthNumber(match[1]);
    return month ? utcDate(+match[3], month, +match[2]) : null;
  }
  // 31 Mar 2026
  if ((match = text.match(/^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})\b/i))) {
    const month = monthNumber(match[2]);
    return month ? utcDate(+match[3], month, +match[1]) : null;
  }
  return null;
}

// True for a ticket when the same worker has another ticket up to 7 days before it.
// Same-day tickets count, in file order. Takes objects with worker and date.
export function markRepeatContacts(tickets) {
  const repeats = tickets.map(() => false);
  const dated = tickets
    .map(({ worker, date }, index) => ({ worker: String(worker ?? '').trim(), date, index }))
    .filter(({ worker, date }) => worker !== '' && date !== null)
    .sort((a, b) => a.date - b.date || a.index - b.index);

  const lastSeen = new Map();
  for (const { worker, date, index } of dated) {
    if (lastSeen.has(worker) && date - lastSeen.get(worker) <= REPEAT_DAYS * DAY_MS) {
      repeats[index] = true;
    }
    lastSeen.set(worker, date);
  }
  return repeats;
}

// Share of tickets per problem before and from the cut-off date. Undated tickets are left out.
// Shares are whole percents, so the Up or Down mark always fits the numbers on screen.
export function compareShares(tickets, cutoff, problemIds) {
  const dated = tickets.filter(({ date }) => date !== null);
  const before = dated.filter(({ date }) => date < cutoff);
  const after = dated.filter(({ date }) => date >= cutoff);
  const share = (list, id) =>
    list.length === 0 ? 0 : Math.round((list.filter(({ problem }) => problem === id).length / list.length) * 100);

  const rows = problemIds.map((id) => {
    const beforeShare = share(before, id);
    const afterShare = share(after, id);
    const change = afterShare - beforeShare;
    const trend = change >= CHANGE_POINTS ? 'up' : change <= -CHANGE_POINTS ? 'down' : 'same';
    return { id, before: beforeShare, after: afterShare, trend };
  });
  return { beforeTotal: before.length, afterTotal: after.length, rows };
}

function periodStart(ms, unit) {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (unit === 'week') return ms - ((date.getUTCDay() + 6) % 7) * DAY_MS;
  if (unit === 'month') return Date.UTC(year, month, 1);
  return Date.UTC(year, month - (month % 3), 1);
}

function nextPeriod(ms, unit) {
  const date = new Date(ms);
  if (unit === 'week') return ms + 7 * DAY_MS;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + (unit === 'month' ? 1 : 3), 1);
}

// Tickets per week, month or quarter, picked from the date range, with empty periods kept.
// Each period also counts the tickets in one highlighted problem. Undated tickets are left out.
export function countOverTime(tickets, highlightId) {
  const dated = tickets.filter(({ date }) => date !== null);
  if (dated.length === 0) return { unit: null, periods: [] };

  const first = dated.reduce((min, { date }) => Math.min(min, date), Infinity);
  const last = dated.reduce((max, { date }) => Math.max(max, date), -Infinity);
  const spanDays = (last - first) / DAY_MS;
  const unit = spanDays <= WEEKLY_MAX_DAYS ? 'week' : spanDays <= MONTHLY_MAX_DAYS ? 'month' : 'quarter';

  const periods = [];
  const byStart = new Map();
  for (let start = periodStart(first, unit); start <= last; start = nextPeriod(start, unit)) {
    const period = { start, total: 0, highlighted: 0 };
    periods.push(period);
    byStart.set(start, period);
  }
  for (const { date, problem } of dated) {
    const period = byStart.get(periodStart(date, unit));
    period.total += 1;
    if (problem === highlightId) period.highlighted += 1;
  }
  return { unit, periods };
}

// Sample mode counts only the reviews that describe a problem.
export function isSampleComplaint(row) {
  return row.counted === 'yes' && row.hand_label_detail !== 'Mostly positive';
}
