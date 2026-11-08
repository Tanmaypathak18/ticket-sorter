// Turns an uploaded ticket export into the template columns. No browser-only code,
// so this runs in the page and in Node.

export const TEMPLATE_FIELDS = ['ticket_id', 'created_at', 'worker_id', 'subject', 'description'];

// Header names to look for, best match first.
const FIELD_HEADERS = {
  ticket_id: ['id', 'ticket id', 'ticket number', 'case id'],
  created_at: ['created at', 'created', 'date', 'opened', 'submitted'],
  worker_id: ['requester id', 'user id', 'worker id', 'customer id', 'requester external id'],
  subject: ['subject', 'title', 'topic'],
  description: ['description', 'comment', 'body', 'message', 'details', 'text'],
};

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

// Ignores case, spaces, underscores, dots and hyphens, so "Requester_ID" and "requester.id" match "requester id".
export function normalizeHeader(header) {
  return String(header ?? '').toLowerCase().replace(/[\s_.-]+/g, '');
}

// Picks a column for each template field. Each column is used once at most. '' means none.
// Given the rows, it skips columns that are blank in every row, like an empty worker_id.
export function guessMapping(columns, rows = []) {
  const isBlank = (column) => rows.length > 0 && rows.every((row) => cellText(row[column]).trim() === '');
  const used = new Set(columns.filter(isBlank));
  const mapping = {};
  for (const field of TEMPLATE_FIELDS) {
    mapping[field] = '';
    for (const name of FIELD_HEADERS[field]) {
      const column = columns.find((candidate) => !used.has(candidate) && normalizeHeader(candidate) === normalizeHeader(name));
      if (column !== undefined) {
        mapping[field] = column;
        used.add(column);
        break;
      }
    }
  }
  return mapping;
}

export function hasTicketText(mapping) {
  return Boolean(mapping.subject || mapping.description);
}

// Turns one value into cell text. Dates become 2026-03-31, lists are joined, deeper objects stay as JSON.
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // Spreadsheet dates can land at midnight local time or UTC. Half a day either way keeps the same calendar day.
    return Number.isNaN(value.getTime()) ? '' : new Date(value.getTime() + HALF_DAY_MS).toISOString().slice(0, 10);
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Flattens one level, so {"requester": {"id": 7}} gives a "requester.id" column.
export function flattenRecord(record) {
  const flat = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        flat[`${key}.${innerKey}`] = cellText(innerValue);
      }
    } else {
      flat[key] = cellText(value);
    }
  }
  return flat;
}

// Accepts an array of objects, or an object holding exactly one array of objects.
export function recordsFromJson(data) {
  let records = data;
  if (!Array.isArray(data)) {
    const arrays = data !== null && typeof data === 'object' ? Object.values(data).filter(Array.isArray) : [];
    if (arrays.length !== 1) {
      return { error: 'This JSON file needs a list of tickets, or an object holding one list of tickets.' };
    }
    [records] = arrays;
  }
  if (!records.every((record) => record !== null && typeof record === 'object' && !Array.isArray(record))) {
    return { error: 'Each ticket in this JSON file needs to be an object with named fields.' };
  }
  return { records };
}

// Builds rows and columns, keeping columns in the order they first appear.
export function tableFromRecords(records) {
  const rows = records.map(flattenRecord);
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
  }
  return { rows, columns };
}

export function toTemplateRows(rows, mapping) {
  return rows.map((row) =>
    Object.fromEntries(TEMPLATE_FIELDS.map((field) => [field, mapping[field] ? cellText(row[mapping[field]]) : ''])),
  );
}
