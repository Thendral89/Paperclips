// Small shared helpers used across every route module.

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

export function badRequest(message) {
  return json({ error: message }, { status: 400 });
}

export function notFound(message = "Not found") {
  return json({ error: message }, { status: 404 });
}

export function unauthorized(message = "Unauthorized") {
  return json({ error: message }, { status: 401 });
}

// Cloudflare's crypto.randomUUID() is available in the Workers runtime —
// used for staff-link tokens. 32 random bytes, hex-encoded, unguessable.
export function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizePhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "").slice(-10); // last 10 digits, ignores +91/spaces/dashes
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ── CSV — export/import for Leads and Accounts (see README §"CSV
// import/export" for the why). No external library: the format is simple
// enough that a hand-rolled RFC4180 parser/writer is less risk than a
// dependency, and it keeps the Worker bundle small.

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// columns: [{ key, label }] — label is the header cell, key reads the value
// off each row object. \r\n line endings + a UTF-8 CSV are what Excel and
// Google Sheets both expect without a "which encoding?" prompt on import.
export function toCSV(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c.key])).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

// Minimal RFC4180 parser: quoted fields, embedded commas/newlines, escaped
// ("") quotes, and a leading BOM (Excel adds one on "Save as CSV UTF-8").
// Returns { headers, rows } — rows is an array of plain objects keyed by
// lowercased/trimmed header, so callers can look up r.name / r.phone / etc.
// regardless of how the source file capitalized its columns.
export function parseCSV(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };
  const clean = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") pushField();
    else if (c === "\n") { pushField(); pushRow(); }
    else if (c === "\r") { /* no-op — \n (or EOF) closes the row */ }
    else field += c;
  }
  if (field.length || row.length) { pushField(); pushRow(); }
  while (rows.length && rows[rows.length - 1].every((f) => f === "")) rows.pop();
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const dataRows = rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] ?? "").trim(); });
    return obj;
  });
  return { headers, rows: dataRows };
}
