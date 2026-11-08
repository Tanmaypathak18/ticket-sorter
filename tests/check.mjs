// Run with: node tests/check.mjs
import { readFileSync } from 'node:fs';
import {
  compileRules,
  sortTicket,
  summarize,
  highlightParts,
  parseDate,
  markRepeatContacts,
  compareShares,
  countOverTime,
  isSampleComplaint,
} from '../js/sorter.js';
import {
  TEMPLATE_FIELDS,
  guessMapping,
  hasTicketText,
  cellText,
  recordsFromJson,
  tableFromRecords,
  toTemplateRows,
} from '../js/converter.js';

const MIN_AGREEMENT = 70;

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

function percent(part, whole) {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

const rules = readJson('../data/rules.json');
const reviews = readJson('../data/sample_reviews.json');
const compiled = compileRules(rules);

// Small rule set, so these tests keep their meaning if rules.json changes.
const testRules = compileRules({
  order: ['first', 'second'],
  categories: {
    first: ['dnr', 'late', "doctor's note"],
    second: ['pay', 'not paid', 'no-show'],
  },
  flags: { no_reason: ['no reason'] },
});

const problemOf = (text) => sortTicket(text, testRules).problem;
const flagOf = (text) => sortTicket(text, testRules).flags.no_reason;

const tests = [
  ['"translate" does not count as "late"', problemOf('Please translate this') === 'other'],
  ['"late" counts as "late"', problemOf('I was late') === 'first'],
  ['"DNR" counts as "dnr"', problemOf('Got a DNR today') === 'first'],
  ['"DNRs" does not count as "dnr"', problemOf('Got two DNRs') === 'other'],
  ['Word next to punctuation still counts', problemOf('(late), again') === 'first'],
  ['Phrase matches across a line break', problemOf('it was not\npaid') === 'second'],
  ['Curly apostrophe counts', problemOf('I have a doctor’s note') === 'first'],
  ['A word used twice scores once', problemOf('late late late, not paid, pay') === 'second'],
  ['Highest score wins', problemOf('late, pay, no-show') === 'second'],
  ['Ties go to the problem listed first', problemOf('pay was late') === 'first'],
  ['No matches is "other"', problemOf('Nothing here') === 'other'],
  ['Empty text is "other"', problemOf('') === 'other'],
  ['Missing text is "other"', problemOf(undefined) === 'other'],
  ['Flag turns on', flagOf('Removed for no reason') === true],
  ['Flag stays off', flagOf('Removed for a reason') === false],
  ['Real rules: "translate" is "other"', sortTicket('Please translate this', compiled).problem === 'other'],
  ['Real rules: "DNR" is a facility report', sortTicket('I got a DNR', compiled).problem === 'facility_report'],
];

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hits = (text, words) =>
  highlightParts(text, words).filter(({ hit }) => hit).map((part) => part.text);
const joined = (text, words) => highlightParts(text, words).map((part) => part.text).join('');

tests.push(
  ['Highlight marks each use of a word', sameList(hits('Late, then late again', ['late']), ['Late', 'late'])],
  ['Highlight skips part of a word', sameList(hits('translate', ['late']), [])],
  ['Highlight joins overlapping phrases', sameList(hits('no call no show', ['no call', 'call no show']), ['no call', ' no show'])],
  ['Highlight keeps the original text', joined('A doctor\u2019s note, late', ["doctor's note", 'late']) === 'A doctor\u2019s note, late'],
  ['Highlight of missing text is empty', sameList(highlightParts(undefined, ['late']), [])],
);

const march31 = Date.UTC(2026, 2, 31);
const day = (date) => parseDate(date);
const repeatsOf = (tickets) => markRepeatContacts(tickets.map(([worker, date]) => ({ worker, date: day(date) })));
const sharedTickets = [
  ...Array(10).fill({ problem: 'a', date: day('2025-01-01') }),
  ...Array(8).fill({ problem: 'a', date: day('2026-01-01') }),
  ...Array(2).fill({ problem: 'b', date: day('2026-01-01') }),
  { problem: 'b', date: null },
];
const shares = compareShares(sharedTickets, day('2025-06-01'), ['a', 'b', 'c']);

tests.push(
  ['Reads 2026-03-31', day('2026-03-31') === march31],
  ['Reads a date with a time', day('2026-03-31T14:22:05Z') === march31],
  ['Reads 03/31/2026', day('03/31/2026') === march31],
  ['Reads 3/31/26', day('3/31/26') === march31],
  ['Reads 31/03/2026', day('31/03/2026') === march31],
  ['Reads Mar 31, 2026', day('Mar 31, 2026') === march31],
  ['Reads March 31 2026', day('March 31 2026') === march31],
  ['Reads 31 Mar 2026', day('31 Mar 2026') === march31],
  ['Rejects a date that does not exist', day('2026-02-30') === null],
  ['Rejects text that is not a date', day('sometime last week') === null],
  ['Blank date is not read', day('') === null],
  ['Three tickets in 7 days flag the 2nd and 3rd',
    sameList(repeatsOf([['w1', '2026-03-01'], ['w1', '2026-03-05'], ['w1', '2026-03-08']]), [false, true, true])],
  ['Exactly 7 days apart is a repeat', sameList(repeatsOf([['w1', '2026-03-01'], ['w1', '2026-03-08']]), [false, true])],
  ['8 days apart is not a repeat', sameList(repeatsOf([['w1', '2026-03-01'], ['w1', '2026-03-09']]), [false, false])],
  ['File order does not matter', sameList(repeatsOf([['w1', '2026-03-05'], ['w1', '2026-03-01']]), [true, false])],
  ['Different workers are not repeats', sameList(repeatsOf([['w1', '2026-03-01'], ['w2', '2026-03-02']]), [false, false])],
  ['Blank worker or date is not a repeat', sameList(repeatsOf([['', '2026-03-01'], ['', '2026-03-02'], ['w1', 'x'], ['w1', 'x']]), [false, false, false, false])],
  ['Period split leaves out undated tickets', shares.beforeTotal === 10 && shares.afterTotal === 10],
  ['Down by 5 points or more', shares.rows[0].before === 100 && shares.rows[0].after === 80 && shares.rows[0].trend === 'down'],
  ['Up by 5 points or more', shares.rows[1].trend === 'up'],
  ['Under 5 points is about the same', shares.rows[2].trend === 'same'
    && compareShares([{ problem: 'a', date: 0 }, { problem: 'a', date: 2 }], 1, ['a']).rows[0].trend === 'same'],
);

const over = (dates, highlight = 'a') =>
  countOverTime(dates.map(([date, problem]) => ({ date: day(date), problem })), highlight);
const weekly = over([['2026-03-04', 'a'], ['2026-03-05', 'b'], ['2026-03-18', 'a'], ['', 'a']]);
const monthly = over([['2026-01-15', 'a'], ['2026-12-02', 'b']]);
const quarterly = over([['2022-02-01', 'a'], ['2026-09-25', 'a']]);

tests.push(
  ['Short ranges count by week, from Monday', weekly.unit === 'week'
    && sameList(weekly.periods.map(({ start, total, highlighted }) => [start, total, highlighted]),
      [[day('2026-03-02'), 2, 1], [day('2026-03-09'), 0, 0], [day('2026-03-16'), 1, 1]])],
  ['Ranges up to 3 years count by month, keeping empty months', monthly.unit === 'month'
    && sameList(monthly.periods.map(({ total }) => total), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])],
  ['Longer ranges count by quarter', quarterly.unit === 'quarter'
    && quarterly.periods.length === 19 && quarterly.periods[0].start === day('2022-01-01')],
  ['No dates means nothing over time', over([['', 'a']]).periods.length === 0],
);

const readText = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const headerOf = (path) => readText(path).split('\n')[0].split(',');
const noneMapped = Object.fromEntries(TEMPLATE_FIELDS.map((field) => [field, '']));
const zendesk = guessMapping(headerOf('fixtures/zendesk_export.csv'));
const jsonTable = tableFromRecords(recordsFromJson(JSON.parse(readText('fixtures/tickets.json'))).records);
const jsonMapping = guessMapping(jsonTable.columns);
const unknown = guessMapping(headerOf('fixtures/no_known_headers.csv'));
const sampleMapping = guessMapping(headerOf('../data/sample_reviews.csv'));

tests.push(
  ['Converter: Zendesk headers map all five fields', sameList(zendesk, {
    ticket_id: 'Id', created_at: 'Created at', worker_id: 'Requester id', subject: 'Subject', description: 'Description',
  })],
  ['Converter: JSON maps id, subject and requester.id',
    jsonMapping.ticket_id === 'id' && jsonMapping.subject === 'subject' && jsonMapping.worker_id === 'requester.id'],
  ['Converter: JSON flattens one level', jsonTable.rows[0]['requester.id'] === '7' && jsonTable.rows[0]['requester.name'] === 'Test worker'],
  ['Converter: JSON keeps columns in first-seen order', jsonTable.columns.join() === 'id,subject,description,created_at,requester.id,requester.name,tags'],
  ['Converter: lists become text', jsonTable.rows[1].tags === 'pay, urgent' && jsonTable.rows[0].tags === undefined],
  ['Converter: unknown headers map to none', sameList(unknown, noneMapped) && !hasTicketText(unknown)],
  ['Converter: sample file maps id, date and text',
    sampleMapping.ticket_id === 'id' && sampleMapping.created_at === 'date' && sampleMapping.description === 'text'],
  ['Converter: ignores case, spaces, underscores, dots and hyphens',
    guessMapping(['TICKET_NUMBER', 'Created-At', 'requester.external_id', 'Body']).ticket_id === 'TICKET_NUMBER'
    && guessMapping(['Created-At']).created_at === 'Created-At'
    && guessMapping(['requester.external_id']).worker_id === 'requester.external_id'],
  ['Converter: blank columns are not guessed', sameList(
    guessMapping(['ticket_id', 'worker_id', 'subject'], [{ ticket_id: '1', worker_id: '', subject: 'Late' }, { ticket_id: '2', worker_id: ' ', subject: 'Pay' }]),
    { ticket_id: 'ticket_id', created_at: '', worker_id: '', subject: 'subject', description: '' },
  )],
  ['Converter: earlier names in the list win', guessMapping(['text', 'details']).description === 'details'],
  ['Converter: subject alone is enough', hasTicketText({ subject: 'Title' }) && !hasTicketText({})],
  ['Converter: JSON object with one list is read', recordsFromJson({ tickets: [{ id: 1 }] }).records.length === 1],
  ['Converter: JSON array is read', recordsFromJson([{ id: 1 }, { id: 2 }]).records.length === 2],
  ['Converter: JSON with two lists asks for one', Boolean(recordsFromJson({ a: [], b: [] }).error)],
  ['Converter: JSON list of plain values is refused', Boolean(recordsFromJson([1, 2]).error)],
  ['Converter: deeper objects stay as text', tableFromRecords([{ a: { b: { c: 1 } } }]).rows[0]['a.b'] === '{"c":1}'],
  ['Converter: spreadsheet dates keep their day',
    cellText(new Date(Date.UTC(2026, 2, 31))) === '2026-03-31' && cellText(new Date(2026, 2, 31)) === '2026-03-31'],
  ['Converter: blanks stay blank', cellText(null) === '' && cellText(undefined) === ''],
  ['Converter: template rows use the mapping', sameList(
    toTemplateRows([{ Id: 5, Title: 'Late', Extra: 'x' }], { ticket_id: 'Id', subject: 'Title' }),
    [{ ticket_id: '5', created_at: '', worker_id: '', subject: 'Late', description: '' }],
  )],
);

console.log('Matching tests');
for (const [name, passed] of tests) {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}`);
}
const failedTests = tests.filter(([, passed]) => !passed).length;

const rows = reviews.filter(isSampleComplaint).map((row) => ({
  row,
  result: sortTicket(row.text, compiled),
}));

const summary = summarize(rows.map(({ result }) => result));
const problemIds = [...rules.order, 'other'];

console.log('\nAgreement with hand sorting, per problem');
console.log('  problem              hand  rules  agree');
for (const id of problemIds) {
  const hand = rows.filter(({ row }) => row.hand_label === id);
  const agree = hand.filter(({ result }) => result.problem === id).length;
  const sorted = summary.problems[id] ?? 0;
  console.log(
    `  ${id.padEnd(20)} ${String(hand.length).padStart(4)}  ${String(sorted).padStart(5)}  ` +
    `${agree} of ${hand.length} (${percent(agree, hand.length)}%)`,
  );
}

const flagColumns = { no_reason_given: 'hand_no_reason', appeal_failed: 'hand_appeal_failed' };

console.log('\nFlag agreement with hand sorting');
for (const [id, column] of Object.entries(flagColumns)) {
  const same = rows.filter(({ row, result }) => (row[column] === 'yes') === result.flags[id]).length;
  const byRules = summary.flags[id] ?? 0;
  const byHand = rows.filter(({ row }) => row[column] === 'yes').length;
  console.log(
    `  ${id.padEnd(20)} ${same} of ${rows.length} (${percent(same, rows.length)}%), ` +
    `rules flagged ${byRules}, hand flagged ${byHand}`,
  );
}

const agreed = rows.filter(({ row, result }) => row.hand_label === result.problem).length;
const overall = percent(agreed, rows.length);
console.log(`\nOverall agreement: ${agreed} of ${rows.length} (${overall}%). Must be at least ${MIN_AGREEMENT}%.`);

if (failedTests > 0 || (agreed / rows.length) * 100 < MIN_AGREEMENT) {
  console.log(`\nCheck failed. Matching tests failed: ${failedTests}.`);
  process.exitCode = 1;
}
