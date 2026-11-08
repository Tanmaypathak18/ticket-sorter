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
} from './sorter.js';
import {
  TEMPLATE_FIELDS,
  guessMapping,
  hasTicketText,
  cellText,
  recordsFromJson,
  tableFromRecords,
  toTemplateRows,
} from './converter.js';

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

// How the sample banner names the reviewers it leaves out: [one, many].
const WRITER_LABELS = {
  'Job applicant': ['job applicant', 'job applicants'],
  Unclear: ['where the writer is unclear', 'where the writer is unclear'],
  'Facility staff': ['facility staff', 'facility staff'],
  'Patient or family': ['patient or family', 'patients or family'],
};

const OTHER = 'other';
const TICKETS_PER_PAGE = 50;
const SVG = 'http://www.w3.org/2000/svg';

const PREVIEW_ROWS = 5;
const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
const SHEETJS_INTEGRITY = 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT';
const DROPZONE_HINT = 'CSV, Excel or JSON. Drop it here, or click to choose one.';

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
  highlight: '',
};

const loadButton = document.getElementById('load-sample');
const csvFile = document.getElementById('csv-file');
const dropzone = document.getElementById('dropzone');
const dropzoneHint = document.getElementById('dropzone-hint');
const converter = document.getElementById('converter');
const converterSource = document.getElementById('converter-source');
const converterWarning = document.getElementById('converter-warning');
const mappingSelects = [...converter.querySelectorAll('select[data-field]')];
const previewRows = document.getElementById('preview-rows');
const downloadTemplateButton = document.getElementById('download-template');
const converterError = document.getElementById('converter-error');
const sampleBanner = document.getElementById('sample-banner');
const sampleSummary = document.getElementById('sample-summary');
const sampleBreakdown = document.getElementById('sample-breakdown');
const loadStatus = document.getElementById('load-status');
const loadNotes = document.getElementById('load-notes');
const answerEmpty = document.getElementById('answer-empty');
const answer = document.getElementById('answer');
const headline = document.getElementById('headline');
const statRow = document.getElementById('stat-row');
const problemList = document.getElementById('problem-list');
const fixChart = document.getElementById('fix-chart');
const flagList = document.getElementById('flag-list');
const timeCard = document.getElementById('time-card');
const timeSub = document.getElementById('time-sub');
const timeHighlight = document.getElementById('time-highlight');
const timeLegend = document.getElementById('time-legend');
const timeChart = document.getElementById('time-chart');
const timeTooltip = document.getElementById('time-tooltip');
const timeRows = document.getElementById('time-rows');
const timeTableHighlight = document.getElementById('time-table-highlight');
const period = document.getElementById('period');
const cutoffInput = document.getElementById('cutoff');
const periodChart = document.getElementById('period-chart');
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

function makeSvg(tag, attributes) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function toDateInput(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatDate(ms, options) {
  return new Date(ms).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}

function readableDate(ms) {
  return formatDate(ms, { year: 'numeric', month: 'short', day: 'numeric' });
}

function categoryName(id) {
  return state.categories.categories.find((category) => category.id === id).name;
}

function categoryOptions(select) {
  select.append(
    ...state.categories.categories.map(({ id, name }) => {
      const option = makeElement('option', '', name);
      option.value = id;
      return option;
    }),
  );
}

// Summary tiles

function drawStat(label, value, detail) {
  const stat = makeElement('div', 'card stat');
  stat.append(
    makeElement('p', 'stat-label', label),
    makeElement('p', 'stat-value', value),
    makeElement('p', 'stat-detail', detail),
  );
  return stat;
}

function fixLevelCounts(summary) {
  const counts = { process: 0, feature: 0, build: 0 };
  for (const category of state.categories.categories) {
    if (category.id === OTHER) continue;
    counts[category.fix_level] += summary.problems[category.id] ?? 0;
  }
  return counts;
}

function drawStats(summary, biggest, largest) {
  const other = summary.problems[OTHER] ?? 0;
  const matched = summary.total - other;
  const process = fixLevelCounts(summary).process;
  statRow.replaceChildren(
    drawStat('Tickets sorted', summary.total.toLocaleString('en-US'), `${matched.toLocaleString('en-US')} matched a problem`),
    drawStat('Biggest problem', `${percent(largest, summary.total)}%`, biggest.name),
    drawStat(
      'Could start with a written process',
      `${percent(process, matched)}%`,
      `${process} of ${matched} matched tickets`,
    ),
    drawStat('In Other', other.toLocaleString('en-US'), `${percent(other, summary.total)}% of tickets. Read these by hand.`),
  );
}

// Problems, biggest first

function drawFixTag(level) {
  const tag = makeElement('span', 'fix-tag');
  tag.append(makeElement('span', `swatch ${level}`), FIX_LEVEL_LABELS[level]);
  return tag;
}

function drawProblem(category, count, total, largest) {
  const item = makeElement('li', 'problem');

  const top = makeElement('div', 'problem-top');
  const numbers = makeElement('span', 'problem-count');
  numbers.append(makeElement('strong', '', String(count)), ` · ${percent(count, total)}%`);
  top.append(makeElement('span', 'problem-name', category.name), numbers);

  // The count and share above carry the numbers, so screen readers skip the bar.
  const track = makeElement('div', 'bar-track');
  track.setAttribute('aria-hidden', 'true');
  const bar = makeElement('div', 'bar');
  bar.style.width = `${largest === 0 ? 0 : (count / largest) * 100}%`;
  track.append(bar);

  const fix = makeElement('p', 'problem-fix');
  fix.append(drawFixTag(category.fix_level), category.fix_idea);

  item.append(top, track, makeElement('p', 'problem-plain', category.plain), fix);
  return item;
}

// How the fixes split

function drawFixSplit(summary) {
  const counts = fixLevelCounts(summary);
  const matched = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const levels = Object.keys(FIX_LEVEL_LABELS);

  const bar = makeElement('div', 'split-bar');
  bar.setAttribute('aria-hidden', 'true');
  for (const level of levels) {
    if (counts[level] === 0) continue;
    const segment = makeElement('div', `split-segment swatch ${level}`);
    segment.style.flex = `${counts[level]} 1 0`;
    segment.title = `${FIX_LEVEL_LABELS[level]}: ${counts[level]} (${percent(counts[level], matched)}%)`;
    bar.append(segment);
  }

  const legend = makeElement('ul', 'split-legend');
  legend.append(
    ...levels.map((level) => {
      const item = document.createElement('li');
      item.append(
        makeElement('span', `swatch ${level}`),
        FIX_LEVEL_LABELS[level],
        makeElement('span', 'split-value', `${counts[level]} · ${percent(counts[level], matched)}%`),
      );
      return item;
    }),
  );

  const other = summary.problems[OTHER] ?? 0;
  const note = makeElement('p', 'split-note', other > 0 ? `Not counting the ${other} in Other.` : '');
  fixChart.replaceChildren(...(matched > 0 ? [bar] : []), legend, note);
}

// Flags

function drawFlag(label, count, total) {
  const flag = makeElement('div', 'flag');
  flag.append(
    makeElement('span', 'flag-count', String(count)),
    makeElement('span', 'flag-label', label),
    makeElement('span', 'flag-share', `${percent(count, total)}% of tickets`),
  );
  return flag;
}

function drawFlags(summary) {
  const flags = ['no_reason_given', 'appeal_failed'].map((id) =>
    drawFlag(FLAG_LABELS[id], summary.flags[id] ?? 0, summary.total),
  );
  flags.push(
    state.hasRepeats
      ? drawFlag(FLAG_LABELS.repeat_contact, summary.flags.repeat_contact ?? 0, summary.total)
      : makeElement('div', 'flag flag-note', 'Pick a worker ID and date column to see repeat contacts.'),
  );
  flagList.replaceChildren(...flags);
}

// Tickets over time

function periodLabels(start, unit) {
  const date = new Date(start);
  if (unit === 'week') {
    return {
      tick: formatDate(start, { month: 'short', day: 'numeric' }),
      long: `Week of ${readableDate(start)}`,
      isMajor: true,
    };
  }
  if (unit === 'month') {
    const isJanuary = date.getUTCMonth() === 0;
    return {
      tick: formatDate(start, isJanuary ? { month: 'short', year: 'numeric' } : { month: 'short' }),
      long: formatDate(start, { month: 'long', year: 'numeric' }),
      isMajor: true,
    };
  }
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 1);
  return {
    tick: String(date.getUTCFullYear()),
    long: `Q${quarter} ${date.getUTCFullYear()} (${formatDate(start, { month: 'short' })} to ${formatDate(end, { month: 'short' })})`,
    isMajor: quarter === 1,
  };
}

function niceStep(rough) {
  const power = 10 ** Math.floor(Math.log10(rough));
  const steps = [1, 2, 5, 10].map((step) => step * power);
  return Math.max(1, steps.find((step) => step >= rough));
}

// A column with a rounded top and a square base, as an SVG path.
function columnPath(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}` +
    `Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function showTooltip(period, labels, hit, plotLeft, columnCenter) {
  const name = categoryName(state.highlight);
  const row = (color, value, text) => {
    const line = makeElement('div', 'tooltip-row');
    const key = makeElement('span', 'tooltip-key');
    key.style.background = color;
    line.append(key, makeElement('strong', '', String(value)), text);
    return line;
  };
  timeTooltip.replaceChildren(
    makeElement('div', 'tooltip-title', labels.long),
    row('var(--series-1)', period.highlighted, name),
    row('var(--de-emphasis)', period.total - period.highlighted, 'Everything else'),
    makeElement('div', 'tooltip-row', `${plural(period.total, 'ticket', 'tickets')} in all`),
  );
  timeTooltip.hidden = false;

  const width = timeChart.clientWidth;
  const tipWidth = timeTooltip.offsetWidth;
  const left = Math.min(Math.max(columnCenter - tipWidth / 2, plotLeft), width - tipWidth);
  timeTooltip.style.left = `${left}px`;
  timeTooltip.style.top = '0px';

  timeChart.querySelectorAll('.hit.is-active').forEach((other) => other.classList.remove('is-active'));
  hit.classList.add('is-active');
}

function hideTooltip() {
  timeTooltip.hidden = true;
  timeChart.querySelectorAll('.hit.is-active').forEach((hit) => hit.classList.remove('is-active'));
}

function drawTimeChart() {
  const { unit, periods } = countOverTime(state.tickets, state.highlight);
  timeCard.hidden = periods.length === 0;
  if (periods.length === 0) return;

  const name = categoryName(state.highlight);
  const dated = periods.reduce((sum, { total }) => sum + total, 0);
  const undated = state.tickets.length - dated;
  timeSub.textContent =
    `${plural(dated, 'ticket', 'tickets')} with a date, counted by ${unit}.` +
    (undated > 0 ? ` ${undated} with no usable date are left out.` : '');

  const legendItem = (className, text) => {
    const item = makeElement('span', 'legend-item');
    const swatch = makeElement('span', 'swatch');
    swatch.style.background = `var(${className})`;
    item.append(swatch, text);
    return item;
  };
  timeLegend.replaceChildren(legendItem('--series-1', name), legendItem('--de-emphasis', 'Everything else'));

  // The numbers table is the same data without needing a pointer.
  timeTableHighlight.textContent = name;
  timeRows.replaceChildren(
    ...periods.map((period) => {
      const row = document.createElement('tr');
      row.append(
        makeElement('td', '', periodLabels(period.start, unit).long),
        makeElement('td', 'number', String(period.total)),
        makeElement('td', 'number', String(period.highlighted)),
      );
      return row;
    }),
  );

  const width = Math.max(timeChart.clientWidth, 260);
  const height = 240;
  const margin = { top: 12, right: 4, bottom: 28, left: 36 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const baseline = margin.top + plotHeight;

  const largest = Math.max(1, ...periods.map(({ total }) => total));
  const step = niceStep(largest / 4);
  const top = Math.ceil(largest / step) * step;
  const scale = (value) => (value / top) * plotHeight;

  const svg = makeSvg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });

  for (let value = 0; value <= top; value += step) {
    const y = baseline - scale(value);
    if (value > 0) {
      svg.append(makeSvg('line', { class: 'grid-line', x1: margin.left, x2: width - margin.right, y1: y, y2: y }));
    }
    const label = makeSvg('text', { class: 'tick-label', x: margin.left - 8, y: y + 4, 'text-anchor': 'end' });
    label.textContent = String(value);
    svg.append(label);
  }

  const band = plotWidth / periods.length;
  const columnWidth = Math.min(24, Math.max(2, band * 0.7));
  const gap = 2;
  let lastTickEnd = -Infinity;

  periods.forEach((period, index) => {
    const x = margin.left + index * band + (band - columnWidth) / 2;
    const center = x + columnWidth / 2;
    const highlightHeight = scale(period.highlighted);
    const restHeight = scale(period.total - period.highlighted);
    const hasBoth = highlightHeight > 0 && restHeight > 0;

    if (highlightHeight > 0) {
      svg.append(makeSvg('path', {
        class: 'column-highlight',
        d: restHeight > 0
          ? `M${x},${baseline}V${baseline - highlightHeight}H${x + columnWidth}V${baseline}Z`
          : columnPath(x, baseline - highlightHeight, columnWidth, highlightHeight, 4),
      }));
    }
    if (restHeight > 0) {
      const restTop = baseline - highlightHeight - restHeight;
      const shown = Math.max(1, restHeight - (hasBoth ? gap : 0));
      svg.append(makeSvg('path', { class: 'column-rest', d: columnPath(x, restTop, columnWidth, shown, 4) }));
    }

    const labels = periodLabels(period.start, unit);
    const tickWidth = labels.tick.length * 7;
    if ((labels.isMajor || index === 0) && center - tickWidth / 2 > lastTickEnd + 12) {
      const tick = makeSvg('text', { class: 'tick-label', x: center, y: baseline + 18, 'text-anchor': 'middle' });
      tick.textContent = labels.tick;
      svg.append(tick);
      lastTickEnd = center + tickWidth / 2;
    }

    // The hover area is the whole band, bigger than the column itself.
    const hit = makeSvg('rect', {
      class: 'hit',
      x: margin.left + index * band,
      y: margin.top,
      width: band,
      height: plotHeight,
    });
    const show = () => showTooltip(period, labels, hit, margin.left, center);
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    svg.append(hit);
  });

  svg.append(makeSvg('line', { class: 'base-line', x1: margin.left, x2: width - margin.right, y1: baseline, y2: baseline }));
  svg.addEventListener('pointerleave', hideTooltip);

  timeChart.querySelector('svg')?.remove();
  timeTooltip.hidden = true;
  timeChart.append(svg);
}

function setUpTimeChart(biggestId) {
  timeHighlight.replaceChildren();
  categoryOptions(timeHighlight);
  state.highlight = biggestId;
  timeHighlight.value = biggestId;
}

// Before and after

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

  const largest = Math.max(10, ...rows.flatMap(({ before, after }) => [before, after]));
  const axisTop = Math.ceil(largest / 10) * 10;
  const position = (share) => `${(share / axisTop) * 100}%`;
  const ordered = [...rows].sort((a, b) => b.after - a.after || b.before - a.before);

  periodChart.hidden = !canCompare;
  periodChart.replaceChildren(
    ...ordered.map(({ id, before, after, trend }) => {
      const item = makeElement('li', 'dumbbell');
      const track = makeElement('div', 'dumbbell-track');
      track.setAttribute('aria-hidden', 'true');
      const line = makeElement('span', 'dumbbell-line');
      line.style.left = position(Math.min(before, after));
      line.style.width = `${(Math.abs(after - before) / axisTop) * 100}%`;
      const beforeDot = makeElement('span', 'dumbbell-dot before');
      beforeDot.style.left = position(before);
      const afterDot = makeElement('span', 'dumbbell-dot after');
      afterDot.style.left = position(after);
      track.append(line, beforeDot, afterDot);

      const values = makeElement('div', 'dumbbell-values', `${before}% → ${after}%`);
      values.append(makeElement('span', `dumbbell-trend ${trend}`, TREND_LABELS[trend]));
      item.append(makeElement('span', 'dumbbell-name', categoryName(id)), track, values);
      return item;
    }),
  );

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

// The whole answer view

function rankedProblems(summary) {
  const countOf = (category) => summary.problems[category.id] ?? 0;
  return [...state.categories.categories].sort((a, b) => countOf(b) - countOf(a));
}

function drawAnswer() {
  const summary = summarize(state.tickets);
  const countOf = (category) => summary.problems[category.id] ?? 0;
  const ranked = rankedProblems(summary);
  const biggest = ranked[0];
  const largest = countOf(biggest);

  headline.textContent =
    `The biggest problem is ${biggest.name}: ` +
    `${largest} of ${summary.total} tickets (${percent(largest, summary.total)}%).`;
  drawStats(summary, biggest, largest);
  problemList.replaceChildren(
    ...ranked.map((category) => drawProblem(category, countOf(category), summary.total, largest)),
  );
  drawFixSplit(summary);
  drawFlags(summary);

  answerEmpty.hidden = true;
  answer.hidden = false;

  // Charts measure their width, so they draw once the answer is on screen.
  if (state.hasDates) {
    drawTimeChart();
    drawPeriod();
  } else {
    timeCard.hidden = true;
  }
}

function clearAnswer() {
  answer.hidden = true;
  answerEmpty.hidden = false;
  check.hidden = true;
  checkEmpty.hidden = false;
}

// Step 3: check and fix

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
  categoryOptions(select);
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
  problemFilter.replaceChildren(all);
  categoryOptions(problemFilter);
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

function saveCsv(csv, fileName) {
  // The mark at the start tells Excel the file is UTF-8.
  const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadCsv() {
  if (!window.Papa) {
    downloadError.textContent = 'The CSV writer did not load. Check your connection and refresh the page.';
    return;
  }
  downloadError.textContent = '';
  saveCsv(sortedCsv(), 'sorted-tickets.csv');
}

// Loading

// The data names the company in one reviewer label. The page never does.
function writerLabel(who, count) {
  const [one, many] = /employee/i.test(who)
    ? ['company employee', 'company employees']
    : WRITER_LABELS[who] ?? [who.toLowerCase(), who.toLowerCase()];
  return `${count} ${count === 1 ? one : many}`;
}

// Fills the sample banner from every sample row, so each number comes from the data.
function describeSample(reviews) {
  const counted = reviews.filter((row) => row.counted === 'yes');
  const complaints = reviews.filter(isSampleComplaint);
  const mostlyPositive = counted.length - complaints.length;

  const leftOut = new Map();
  for (const { counted: isCounted, who } of reviews) {
    if (isCounted !== 'yes') leftOut.set(who, (leftOut.get(who) ?? 0) + 1);
  }
  const leftOutText = [...leftOut]
    .sort((a, b) => b[1] - a[1])
    .map(([who, count]) => writerLabel(who, count))
    .join(', ');

  sampleSummary.textContent =
    `Sample data: ${complaints.length} worker reviews that describe a problem, out of ${reviews.length} ` +
    'public reviews collected from Indeed, BBB, Trustpilot and app stores. Job applicants, facility staff, ' +
    'patients and mostly positive reviews are left out, because they would not become support tickets.';
  sampleBreakdown.replaceChildren(
    makeElement('li', '', `${reviews.length} collected`),
    makeElement('li', '', `${counted.length} written by workers (left out: ${leftOutText})`),
    makeElement('li', '', `${complaints.length} of those describe a problem (left out: ${mostlyPositive} mostly positive)`),
  );
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
  return `${parts.join(' and ')}. These are left out of the charts over time, the period split and repeat contacts.`;
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
  setUpTimeChart(rankedProblems(summarize(tickets))[0].id);
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
  converter.hidden = true;
  csvFile.value = '';
  dropzoneHint.textContent = DROPZONE_HINT;
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
    describeSample(reviews);
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

// Converter: any export into the template columns

function currentMapping() {
  return Object.fromEntries(mappingSelects.map((select) => [select.dataset.field, select.value]));
}

function drawPreview() {
  const mapping = currentMapping();
  converterWarning.hidden = hasTicketText(mapping);
  converterError.textContent = '';
  previewRows.replaceChildren(
    ...toTemplateRows(state.upload.rows.slice(0, PREVIEW_ROWS), mapping).map((templateRow) => {
      const row = document.createElement('tr');
      for (const field of TEMPLATE_FIELDS) {
        const cell = makeElement('td', '', templateRow[field]);
        cell.title = templateRow[field];
        row.append(cell);
      }
      return row;
    }),
  );
}

function drawConverter(sourceNote) {
  const { columns } = state.upload;
  const guess = guessMapping(columns, state.upload.rows);
  for (const select of mappingSelects) {
    const none = makeElement('option', '', 'None');
    none.value = '';
    select.replaceChildren(
      none,
      ...columns.map((column) => {
        const option = makeElement('option', '', column);
        option.value = column;
        return option;
      }),
    );
    select.value = guess[select.dataset.field];
  }
  converterSource.textContent = sourceNote;
  converter.hidden = false;
  drawPreview();
}

// Every file type ends here, as rows of named columns.
function useUploadedTable(rows, columns, sourceNote) {
  if (columns.length === 0 || rows.length === 0) {
    converter.hidden = true;
    showStatus('This file has no tickets in it. Check that it has a header row and at least one ticket.', true);
    return;
  }

  // The sample file holds every review, so it keeps the same rows as sample mode.
  const isSampleFile = columns.includes('counted') && columns.includes('hand_label_detail');
  const kept = isSampleFile ? rows.filter(isSampleComplaint) : rows;
  state.upload = { rows: kept, allRows: rows, columns, isSampleFile };

  clearAnswer();
  sampleBanner.hidden = true;
  showStatus(`${plural(kept.length, 'ticket', 'tickets')} read. Check the matched columns.`);
  showNotes(isSampleFile
    ? `This is the sample file, so only the ${kept.length} of ${rows.length} reviews that describe a problem are kept.`
    : '');
  drawConverter(sourceNote);
}

function readCsv(file) {
  if (!window.Papa) {
    showStatus('The CSV reader did not load. Check your connection and refresh the page.', true);
    return;
  }
  window.Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    complete: (results) => useUploadedTable(results.data, results.meta.fields ?? [], `Read ${file.name} as a CSV file.`),
    error: () => showStatus('Could not read this file. Check that it is a CSV.', true),
  });
}

async function readJson(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showStatus('Could not read this file. Check that it is valid JSON.', true);
    return;
  }
  const { records, error } = recordsFromJson(data);
  if (error) {
    showStatus(error, true);
    return;
  }
  const { rows, columns } = tableFromRecords(records);
  useUploadedTable(rows, columns, `Read ${file.name} as JSON. Fields inside a field, like requester.id, are shown as their own columns.`);
}

// SheetJS loads only when someone picks an Excel file. The hash makes the browser refuse a changed copy.
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SHEETJS_URL;
    script.integrity = SHEETJS_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
}

async function readExcel(file) {
  showStatus('Reading the Excel file…');
  try {
    await loadSheetJs();
  } catch {
    showStatus('The Excel reader did not load. Check your connection and refresh the page.', true);
    return;
  }
  let workbook;
  try {
    workbook = window.XLSX.read(await file.arrayBuffer(), { cellDates: true });
  } catch {
    showStatus('Could not read this file. Check that it is an Excel file.', true);
    return;
  }
  const [sheetName] = workbook.SheetNames;
  const records = window.XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: true });
  const rows = records.map((record) =>
    Object.fromEntries(Object.entries(record).map(([column, value]) => [column, cellText(value)])),
  );
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const others = workbook.SheetNames.length - 1;
  useUploadedTable(
    rows,
    columns,
    `Read the first sheet only: ${sheetName}.` + (others > 0 ? ` The other ${plural(others, 'sheet was', 'sheets were')} left out.` : ''),
  );
}

// The file is read here in the browser. Nothing is sent anywhere.
function readFile(file) {
  if (!file) return;
  dropzoneHint.textContent = file.name;
  converterError.textContent = '';
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'xlsx' || extension === 'xls') readExcel(file);
  else if (extension === 'json') readJson(file);
  else readCsv(file);
}

function handleDrop(event) {
  event.preventDefault();
  dropzone.classList.remove('is-dragging');
  readFile(event.dataTransfer.files[0]);
}

function handleDragOver(event) {
  event.preventDefault();
  dropzone.classList.add('is-dragging');
}

function checkMapping() {
  if (hasTicketText(currentMapping())) return true;
  converterError.textContent = 'Pick a subject or description column first.';
  return false;
}

async function sortUpload(event) {
  event.preventDefault();
  if (!checkMapping()) return;

  try {
    await loadSettings();
  } catch (error) {
    console.warn('Could not load the sorting rules', error);
    showStatus('Could not load the sorting rules. Refresh the page and try again.', true);
    return;
  }

  const mapping = currentMapping();
  const { rows, allRows, columns, isSampleFile } = state.upload;
  useTickets(rows, columns, {
    textColumns: [mapping.subject, mapping.description].filter(Boolean),
    dateColumn: mapping.created_at,
    workerColumn: mapping.worker_id,
    isSample: false,
  });
  if (isSampleFile) describeSample(allRows);
  sampleBanner.hidden = !isSampleFile;
  showStatus(`${plural(rows.length, 'ticket', 'tickets')} loaded`);
  const sampleNote = isSampleFile
    ? `This is the sample file, so only the ${rows.length} of ${allRows.length} reviews that describe a problem are counted. `
    : '';
  showNotes(sampleNote + dateNotes(rows, mapping.created_at));
  document.getElementById('step-answer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function downloadTemplate() {
  if (!checkMapping()) return;
  if (!window.Papa) {
    converterError.textContent = 'The CSV writer did not load. Check your connection and refresh the page.';
    return;
  }
  const templateRows = toTemplateRows(state.upload.rows, currentMapping());
  const csv = window.Papa.unparse(
    { fields: TEMPLATE_FIELDS, data: templateRows.map((row) => TEMPLATE_FIELDS.map((field) => row[field])) },
    { escapeFormulae: true },
  );
  saveCsv(csv, 'tickets-template.csv');
}

function changeHighlight() {
  state.highlight = timeHighlight.value;
  drawTimeChart();
}

// Redraws the time chart when its width changes, at most once a frame.
let lastChartWidth = 0;
let resizeFrame = 0;
const chartResize = new ResizeObserver(() => {
  const width = timeChart.clientWidth;
  if (width === lastChartWidth || timeCard.hidden || state.tickets.length === 0) return;
  lastChartWidth = width;
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(drawTimeChart);
});

loadButton.addEventListener('click', loadSample);
csvFile.addEventListener('change', () => readFile(csvFile.files[0]));
dropzone.addEventListener('dragover', handleDragOver);
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragging'));
dropzone.addEventListener('drop', handleDrop);
converter.addEventListener('submit', sortUpload);
mappingSelects.forEach((select) => select.addEventListener('change', drawPreview));
downloadTemplateButton.addEventListener('click', downloadTemplate);
timeHighlight.addEventListener('change', changeHighlight);
cutoffInput.addEventListener('change', drawPeriod);
problemFilter.addEventListener('change', resetTableAndDraw);
ticketSearch.addEventListener('input', resetTableAndDraw);
showMoreButton.addEventListener('click', showMoreTickets);
downloadButton.addEventListener('click', downloadCsv);
chartResize.observe(timeChart);
