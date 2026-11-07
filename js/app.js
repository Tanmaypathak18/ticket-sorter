import {
  compileRules,
  sortTicket,
  summarize,
  highlightParts,
  parseDate,
  markRepeatContacts,
  compareShares,
  isSampleComplaint,
} from './sorter.js';

const FIX_LEVEL_LABELS = {
  process: 'Written process',
  feature: 'Change something that exists',
  build: 'New build',
};

const FLAG_LABELS = {
  no_reason_given: 'Says no reason was given',
  appeal_failed: 'Appeal or dispute went nowhere',
  repeat_contact: 'Wrote in again within 7 days',
};

const TREND_LABELS = { up: 'Up', down: 'Down', same: 'About the same' };

const TICKETS_PER_PAGE = 50;

const LIKELY_TEXT_COLUMNS = ['subject', 'description', 'text'];
const LIKELY_DATE_COLUMNS = ['created_at', 'date'];
const LIKELY_WORKER_COLUMNS = ['worker_id'];

const state = {
  tickets: [],
  columns: [],
  isSample: false,
  hasRepeats: false,
  hasDates: false,
  categories: null,
  rules: null,
  upload: null,
  rowsShown: TICKETS_PER_PAGE,
  isLoading: false,
};

const loadButton = document.getElementById('load-sample');
const csvFile = document.getElementById('csv-file');
const columnPicker = document.getElementById('column-picker');
const textColumns = document.getElementById('text-columns');
const dateColumn = document.getElementById('date-column');
const workerColumn = document.getElementById('worker-column');
const pickerError = document.getElementById('picker-error');
const sampleBanner = document.getElementById('sample-banner');
const loadStatus = document.getElementById('load-status');
const loadNotes = document.getElementById('load-notes');
const answerEmpty = document.getElementById('answer-empty');
const answer = document.getElementById('answer');
const headline = document.getElementById('headline');
const problemList = document.getElementById('problem-list');
const flagList = document.getElementById('flag-list');
const period = document.getElementById('period');
const cutoffInput = document.getElementById('cutoff');
const periodNote = document.getElementById('period-note');
const periodRows = document.getElementById('period-rows');
const checkEmpty = document.getElementById('check-empty');
const check = document.getElementById('check');
const agreement = document.getElementById('agreement');
const problemFilter = document.getElementById('problem-filter');
const ticketSearch = document.getElementById('ticket-search');
const tableCount = document.getElementById('table-count');
const ticketRows = document.getElementById('ticket-rows');
const showMoreButton = document.getElementById('show-more');
const downloadButton = document.getElementById('download-csv');
const downloadError = document.getElementById('download-error');

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

async function loadSettings() {
  if (state.rules) return;
  const [categories, rules] = await Promise.all([
    fetchJson('data/categories.json'),
    fetchJson('data/rules.json'),
  ]);
  state.categories = categories;
  state.rules = rules;
}

function showStatus(message, isError = false) {
  loadStatus.textContent = message;
  loadStatus.classList.toggle('error', isError);
}

function showNotes(message) {
  loadNotes.textContent = message;
  loadNotes.hidden = message === '';
}

function percent(part, whole) {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function makeElement(tag, className, text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function toDateInput(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function readableDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function drawProblem(category, count, total, largest) {
  const item = makeElement('li', 'problem');

  const top = makeElement('div', 'problem-top');
  top.append(
    makeElement('span', 'problem-name', category.name),
    makeElement('span', 'problem-count', `${count} (${percent(count, total)}%)`),
  );

  // The count and share above carry the numbers, so screen readers skip the bar.
  const track = makeElement('div', 'bar-track');
  track.setAttribute('aria-hidden', 'true');
  const bar = makeElement('div', 'bar');
  bar.style.width = `${largest === 0 ? 0 : (count / largest) * 100}%`;
  track.append(bar);

  const fix = makeElement('p', 'problem-fix');
  fix.append(
    makeElement('span', 'fix-level', `${FIX_LEVEL_LABELS[category.fix_level]}: `),
    category.fix_idea,
  );

  item.append(top, track, makeElement('p', 'problem-plain', category.plain), fix);
  return item;
}

function drawFlag(label, count) {
  const flag = makeElement('div', 'flag');
  flag.append(makeElement('span', 'flag-count', String(count)), label);
  return flag;
}

function drawFlags(summary) {
  const flags = ['no_reason_given', 'appeal_failed'].map((id) =>
    drawFlag(FLAG_LABELS[id], summary.flags[id] ?? 0),
  );
  flags.push(
    state.hasRepeats
      ? drawFlag(FLAG_LABELS.repeat_contact, summary.flags.repeat_contact ?? 0)
      : makeElement('div', 'flag flag-note', 'Pick a worker ID and date column to see repeat contacts.'),
  );
  flagList.replaceChildren(...flags);
}

function drawPeriod() {
  const cutoff = parseDate(cutoffInput.value);
  if (cutoff === null) return;

  const ids = state.categories.categories.map(({ id }) => id);
  const { beforeTotal, afterTotal, rows } = compareShares(state.tickets, cutoff, ids);
  const canCompare = beforeTotal > 0 && afterTotal > 0;

  const undated = state.tickets.filter(({ date }) => date === null).length;
  periodNote.textContent =
    `Before ${readableDate(cutoff)}: ${plural(beforeTotal, 'ticket', 'tickets')}. ` +
    `From then on: ${plural(afterTotal, 'ticket', 'tickets')}.` +
    (undated > 0 ? ` Left out: ${undated} with no usable date.` : '') +
    (canCompare ? '' : ' Pick a date with tickets on both sides to compare.');

  periodRows.replaceChildren(
    ...rows.map(({ id, before, after, trend }) => {
      const row = document.createElement('tr');
      const change = canCompare ? TREND_LABELS[trend] : '';
      row.append(
        makeElement('td', '', categoryName(id)),
        makeElement('td', 'number', beforeTotal > 0 ? `${before}%` : ''),
        makeElement('td', 'number', afterTotal > 0 ? `${after}%` : ''),
        makeElement('td', canCompare && trend !== 'same' ? 'trend-changed' : '', change),
      );
      return row;
    }),
  );
}

function drawAnswer() {
  const summary = summarize(state.tickets);
  const countOf = (category) => summary.problems[category.id] ?? 0;
  const ranked = [...state.categories.categories].sort((a, b) => countOf(b) - countOf(a));
  const biggest = ranked[0];
  const largest = countOf(biggest);

  headline.textContent =
    `The biggest problem is ${biggest.name}: ` +
    `${largest} of ${summary.total} tickets (${percent(largest, summary.total)}%).`;
  problemList.replaceChildren(
    ...ranked.map((category) => drawProblem(category, countOf(category), summary.total, largest)),
  );
  drawFlags(summary);
  if (state.hasDates) drawPeriod();

  answerEmpty.hidden = true;
  answer.hidden = false;
}

function clearAnswer() {
  answer.hidden = true;
  answerEmpty.hidden = false;
  check.hidden = true;
  checkEmpty.hidden = false;
}

function categoryName(id) {
  return state.categories.categories.find((category) => category.id === id).name;
}

function drawAgreement() {
  agreement.hidden = !state.isSample;
  if (!state.isSample) return;
  const agreed = state.tickets.filter(({ row, problem }) => row.hand_label === problem).length;
  const total = state.tickets.length;
  agreement.textContent =
    `The rules agree with my hand sorting on ${agreed} of ${total} (${percent(agreed, total)}%).`;
}

function moveTicket(ticket, problem, movedLabel) {
  ticket.problem = problem;
  ticket.moved = problem !== ticket.ruleProblem;
  movedLabel.hidden = !ticket.moved;
  drawAnswer();
  drawAgreement();
}

function drawTicketText(ticket) {
  const cell = document.createElement('td');
  const text = makeElement('p', 'ticket-text');
  text.append(
    ...highlightParts(ticket.text, ticket.words).map((part) =>
      part.hit ? makeElement('mark', '', part.text) : part.text,
    ),
  );
  cell.append(text);
  if (ticket.words.length > 0) {
    cell.append(makeElement('p', 'matched', `Matched: ${ticket.words.join(', ')}`));
  }
  return cell;
}

function drawTicketProblem(ticket, ticketNumber) {
  const cell = document.createElement('td');
  const select = document.createElement('select');
  select.setAttribute('aria-label', `Problem for ticket ${ticketNumber}`);
  select.append(
    ...state.categories.categories.map(({ id, name }) => {
      const option = makeElement('option', '', name);
      option.value = id;
      return option;
    }),
  );
  select.value = ticket.problem;

  const movedLabel = makeElement('span', 'moved', 'moved by you');
  movedLabel.hidden = !ticket.moved;
  select.addEventListener('change', () => moveTicket(ticket, select.value, movedLabel));

  cell.append(select, movedLabel);
  return cell;
}

function drawTicketFlags(ticket) {
  const cell = document.createElement('td');
  const onFlags = Object.keys(FLAG_LABELS).filter((id) => ticket.flags[id]);
  if (onFlags.length > 0) {
    const list = makeElement('ul', 'ticket-flags');
    list.append(...onFlags.map((id) => makeElement('li', '', FLAG_LABELS[id])));
    cell.append(list);
  }
  return cell;
}

function filteredTickets() {
  const problem = problemFilter.value;
  const search = ticketSearch.value.trim().toLowerCase();
  return state.tickets.filter(
    (ticket) =>
      (problem === 'all' || ticket.problem === problem) &&
      ticket.text.toLowerCase().includes(search),
  );
}

function drawTicketTable() {
  const matching = filteredTickets();
  const shown = matching.slice(0, state.rowsShown);
  ticketRows.replaceChildren(
    ...shown.map((ticket) => {
      const row = document.createElement('tr');
      row.append(
        drawTicketText(ticket),
        drawTicketProblem(ticket, state.tickets.indexOf(ticket) + 1),
        drawTicketFlags(ticket),
      );
      return row;
    }),
  );
  tableCount.textContent = `Showing ${shown.length} of ${plural(matching.length, 'ticket', 'tickets')}.`;
  showMoreButton.hidden = shown.length >= matching.length;
}

function setUpCheck() {
  const all = makeElement('option', '', 'All problems');
  all.value = 'all';
  problemFilter.replaceChildren(
    all,
    ...state.categories.categories.map(({ id, name }) => {
      const option = makeElement('option', '', name);
      option.value = id;
      return option;
    }),
  );
  ticketSearch.value = '';
  state.rowsShown = TICKETS_PER_PAGE;
  downloadError.textContent = '';
  drawAgreement();
  drawTicketTable();
  checkEmpty.hidden = true;
  check.hidden = false;
}

function resetTableAndDraw() {
  state.rowsShown = TICKETS_PER_PAGE;
  drawTicketTable();
}

function showMoreTickets() {
  state.rowsShown += TICKETS_PER_PAGE;
  drawTicketTable();
}

// Keeps the original columns untouched if a file already has a column with this name.
function newColumnName(name) {
  return state.columns.includes(name) ? `${name} (sorted)` : name;
}

function sortedCsv() {
  const flagIds = ['no_reason_given', 'appeal_failed', ...(state.hasRepeats ? ['repeat_contact'] : [])];
  const fields = [
    ...state.columns,
    ...['problem', ...flagIds.map((id) => FLAG_LABELS[id]), 'matched words', 'moved by you'].map(newColumnName),
  ];
  const data = state.tickets.map((ticket) => [
    ...state.columns.map((column) => ticket.row[column] ?? ''),
    categoryName(ticket.problem),
    ...flagIds.map((id) => (ticket.flags[id] ? 'yes' : 'no')),
    ticket.words.join('; '),
    ticket.moved ? 'yes' : 'no',
  ]);
  // escapeFormulae stops ticket text from running as a formula in a spreadsheet.
  return window.Papa.unparse({ fields, data }, { escapeFormulae: true });
}

function downloadCsv() {
  if (!window.Papa) {
    downloadError.textContent = 'The CSV writer did not load. Check your connection and refresh the page.';
    return;
  }
  downloadError.textContent = '';
  // The mark at the start tells Excel the file is UTF-8.
  const blob = new Blob(['\ufeff', sortedCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sorted-tickets.csv';
  link.click();
  URL.revokeObjectURL(url);
}

function setUpPeriod() {
  period.hidden = !state.hasDates;
  if (!state.hasDates) return;
  const dates = state.tickets.map(({ date }) => date).filter((date) => date !== null);
  const latest = new Date(dates.reduce((a, b) => Math.max(a, b)));
  cutoffInput.min = toDateInput(dates.reduce((a, b) => Math.min(a, b)));
  cutoffInput.max = toDateInput(latest.getTime());
  latest.setUTCFullYear(latest.getUTCFullYear() - 1);
  cutoffInput.value = toDateInput(latest.getTime());
}

function dateNotes(rows, column) {
  if (!column) return '';
  const blank = rows.filter((row) => String(row[column] ?? '').trim() === '').length;
  const unreadable = rows.filter((row) => {
    const value = String(row[column] ?? '').trim();
    return value !== '' && parseDate(value) === null;
  }).length;
  const parts = [];
  if (unreadable > 0) parts.push(`${plural(unreadable, 'date', 'dates')} could not be read`);
  if (blank > 0) parts.push(`${plural(blank, 'ticket has', 'tickets have')} no date`);
  if (parts.length === 0) return '';
  return `${parts.join(' and ')}. These are left out of the period split and repeat contacts.`;
}

function useTickets(rows, columns, picked) {
  const compiled = compileRules(state.rules);
  const tickets = rows.map((row) => {
    const text = picked.textColumns.map((column) => row[column] ?? '').join(' | ');
    const sorted = sortTicket(text, compiled);
    return {
      row,
      text,
      date: picked.dateColumn ? parseDate(row[picked.dateColumn]) : null,
      worker: picked.workerColumn ? row[picked.workerColumn] : '',
      ruleProblem: sorted.problem,
      moved: false,
      ...sorted,
    };
  });

  state.hasDates = tickets.some(({ date }) => date !== null);
  state.hasRepeats = Boolean(picked.dateColumn && picked.workerColumn);
  if (state.hasRepeats) {
    markRepeatContacts(tickets).forEach((isRepeat, index) => {
      tickets[index].flags.repeat_contact = isRepeat;
    });
  }

  state.tickets = tickets;
  state.columns = columns;
  state.isSample = picked.isSample;
  setUpPeriod();
  drawAnswer();
  setUpCheck();
}

async function loadSample() {
  // Not disabled while loading, because that would drop keyboard focus.
  if (state.isLoading) return;
  state.isLoading = true;
  showStatus('Loading…');
  showNotes('');
  columnPicker.hidden = true;
  csvFile.value = '';
  try {
    await loadSettings();
    const reviews = await fetchJson('data/sample_reviews.json');
    const rows = reviews.filter(isSampleComplaint);
    useTickets(rows, Object.keys(reviews[0]), {
      textColumns: ['text'],
      dateColumn: 'date',
      workerColumn: '',
      isSample: true,
    });
    sampleBanner.hidden = false;
    showStatus(`${rows.length} tickets loaded`);
    showNotes(dateNotes(rows, 'date'));
  } catch (error) {
    console.warn('Could not load sample data', error);
    sampleBanner.hidden = true;
    clearAnswer();
    showStatus('Could not load the sample data. Open this page through a local server and try again.', true);
  } finally {
    state.isLoading = false;
  }
}

function fillColumnSelect(select, fields, likely) {
  const none = makeElement('option', '', 'None');
  none.value = '';
  const options = fields.map((field) => {
    const option = makeElement('option', '', field);
    option.value = field;
    return option;
  });
  select.replaceChildren(none, ...options);
  select.value = fields.find((field) => likely.includes(field.toLowerCase())) ?? '';
}

function drawColumnPicker(fields) {
  textColumns.replaceChildren(
    ...fields.map((field) => {
      const label = makeElement('label', 'checkbox');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = field;
      box.checked = LIKELY_TEXT_COLUMNS.includes(field.toLowerCase());
      label.append(box, field);
      return label;
    }),
  );
  fillColumnSelect(dateColumn, fields, LIKELY_DATE_COLUMNS);
  fillColumnSelect(workerColumn, fields, LIKELY_WORKER_COLUMNS);
  pickerError.textContent = '';
  columnPicker.hidden = false;
}

function handleParsedFile(results) {
  const fields = results.meta.fields ?? [];
  if (fields.length === 0 || results.data.length === 0) {
    columnPicker.hidden = true;
    showStatus('This file has no tickets in it. Check that it has a header row and at least one ticket.', true);
    return;
  }
  state.upload = { rows: results.data, fields };
  clearAnswer();
  sampleBanner.hidden = true;
  showNotes('');
  showStatus(`${plural(results.data.length, 'row', 'rows')} read. Now pick the columns.`);
  drawColumnPicker(fields);
}

// Papa Parse reads the file here in the browser. Nothing is sent anywhere.
function readFile() {
  const file = csvFile.files[0];
  if (!file) return;
  if (!window.Papa) {
    showStatus('The CSV reader did not load. Check your connection and refresh the page.', true);
    return;
  }
  window.Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    complete: handleParsedFile,
    error: () => showStatus('Could not read this file. Check that it is a CSV.', true),
  });
}

async function sortUpload(event) {
  event.preventDefault();
  const picked = {
    textColumns: [...textColumns.querySelectorAll('input:checked')].map(({ value }) => value),
    dateColumn: dateColumn.value,
    workerColumn: workerColumn.value,
    isSample: false,
  };
  if (picked.textColumns.length === 0) {
    pickerError.textContent = 'Pick at least one column with ticket text.';
    return;
  }
  pickerError.textContent = '';

  try {
    await loadSettings();
  } catch (error) {
    console.warn('Could not load the sorting rules', error);
    showStatus('Could not load the sorting rules. Refresh the page and try again.', true);
    return;
  }

  // The sample CSV holds every review, so count the same rows as sample mode.
  const { rows: allRows, fields } = state.upload;
  const isSampleFile = fields.includes('counted') && fields.includes('hand_label_detail');
  const rows = isSampleFile ? allRows.filter(isSampleComplaint) : allRows;

  useTickets(rows, fields, picked);
  sampleBanner.hidden = !isSampleFile;
  showStatus(`${plural(rows.length, 'ticket', 'tickets')} loaded`);
  const sampleNote = isSampleFile
    ? `This is the sample file, so only the ${rows.length} of ${allRows.length} reviews that describe a problem are counted. `
    : '';
  showNotes(sampleNote + dateNotes(rows, picked.dateColumn));
}

loadButton.addEventListener('click', loadSample);
csvFile.addEventListener('change', readFile);
columnPicker.addEventListener('submit', sortUpload);
cutoffInput.addEventListener('change', drawPeriod);
problemFilter.addEventListener('change', resetTableAndDraw);
ticketSearch.addEventListener('input', resetTableAndDraw);
showMoreButton.addEventListener('click', showMoreTickets);
downloadButton.addEventListener('click', downloadCsv);
