/**
 * src/components/spreadsheet-import.js
 *
 * Spreadsheet Fallback (Golden Rule 1) — a dependency-free CSV parser for the
 * Internal Data Hub import flow (assistant-data-hub.js). V1 accepts CSV only;
 * Excel / Google Sheets users export via File → Download → CSV (the import UI
 * says so), which covers all three formats without shipping SheetJS.
 *
 * Usage:
 *   window.SpreadsheetImport.parse(text)
 *     → { headers: [...], rows: [{ header: value, … }, …] }
 *       RFC 4180-aware: quoted cells, escaped quotes (""), commas and newlines
 *       inside quotes. Headers are trimmed; duplicate/empty headers get
 *       positional fallbacks ("column_3"). Rows shorter than the header row are
 *       padded with ''.
 *
 *   window.SpreadsheetImport.fromFile(file) → Promise<same shape>
 *     Rejects for non-CSV extensions (.xlsx etc.) with a message telling the
 *     user how to export a CSV, and for files over 2 MB.
 */
(function () {
  'use strict';

  const MAX_FILE_BYTES = 2 * 1024 * 1024;

  // Split raw CSV text into a matrix of cells (RFC 4180 quoting rules).
  function tokenize(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } // escaped quote
          else inQuotes = false;
        } else cell += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell); cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else {
        cell += ch;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    // Drop rows that are entirely empty (trailing newlines, blank spacer lines).
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  function parse(text) {
    const matrix = tokenize(String(text ?? '').replace(/^﻿/, '')); // strip BOM
    if (matrix.length === 0) return { headers: [], rows: [] };

    const headers = matrix[0].map((h, i) => {
      const clean = String(h).trim();
      return clean || `column_${i + 1}`;
    });
    // De-duplicate headers so later columns don't silently overwrite earlier ones.
    const seen = {};
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i];
      if (seen[key] !== undefined) headers[i] = `${key}_${++seen[key]}`;
      else seen[key] = 1;
    }

    const rows = matrix.slice(1).map((cells) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = String(cells[i] ?? '').trim(); });
      return obj;
    });
    return { headers, rows };
  }

  function fromFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('No file selected.'));
      if (!/\.csv$/i.test(file.name)) {
        return reject(new Error('Please upload a .csv file. In Excel or Google Sheets, use File → Download → CSV first.'));
      }
      if (file.size > MAX_FILE_BYTES) {
        return reject(new Error('That file is over 2 MB — split it into smaller CSVs and import them one at a time.'));
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the file.'));
      reader.onload = () => {
        try {
          const parsed = parse(reader.result);
          if (parsed.rows.length === 0) return reject(new Error('That CSV has no data rows — the first row is treated as headers.'));
          resolve(parsed);
        } catch (err) { reject(err); }
      };
      reader.readAsText(file);
    });
  }

  window.SpreadsheetImport = { parse, fromFile };
})();
