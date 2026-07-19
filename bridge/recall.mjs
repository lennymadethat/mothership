#!/usr/bin/env node
// recall.mjs — pull EXACT past moments out of the Mothership forever-chat archive.
//
// The forever-chat keeps every turn of every part on disk as JSONL. A live
// session only holds the recent verbatim tail + a lossy summary, so anything
// older is out of its head — but never gone. This reaches back into ANY earlier
// part, verbatim, with citations, so a running session can recover a detail
// instead of guessing (or saying it doesn't remember).
//
//   node recall.mjs --key <sessionKey> --query "keywords"  [--context 1] [--limit 8] [--part N] [--any]
//   node recall.mjs --list                 # show available session transcripts + part/turn counts
//
// Case-insensitive. By default ALL terms must appear in a turn (quote a "phrase"
// to keep it together); --any widens to any-term. Exact and cheap — ideal for
// names, IDs, file paths, decisions. No embeddings, no network, no spend.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS = path.join(__dirname, 'data', 'transcripts');

const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

function listTranscripts() {
  let files = [];
  try { files = fs.readdirSync(TRANSCRIPTS).filter((f) => f.endsWith('.jsonl')); } catch {}
  if (!files.length) { console.log('No transcripts found in', TRANSCRIPTS); return; }
  console.log('Available session transcripts (pass one as --key):\n');
  for (const f of files) {
    const key = f.replace(/\.jsonl$/, '');
    let turns = 0, parts = 1;
    try {
      for (const l of fs.readFileSync(path.join(TRANSCRIPTS, f), 'utf8').split('\n').filter(Boolean)) {
        try { const e = JSON.parse(l); if (e.role === 'rollover') parts = Math.max(parts, e.part || parts); else if (e.role === 'user' || e.role === 'assistant') turns++; } catch {}
      }
    } catch {}
    console.log(`  ${key}   (${parts} part${parts > 1 ? 's' : ''}, ${turns} turns)`);
  }
}

if (has('list') || (!opt('key') && !opt('query') && !argv.filter((a) => !a.startsWith('--')).length)) {
  listTranscripts();
  process.exit(0);
}

const key = opt('key');
const query = opt('query') || argv.filter((a) => !a.startsWith('--')).join(' ');
if (!key) { console.error('recall: --key <sessionKey> required (run --list to see keys)'); process.exit(2); }
if (!query) { console.error('recall: --query "<keywords>" required'); process.exit(2); }

const context = Math.max(0, parseInt(opt('context', '1'), 10) || 0);
const limit = Math.max(1, parseInt(opt('limit', '8'), 10) || 8);
const onlyPart = opt('part') ? parseInt(opt('part'), 10) : null;
const anyMode = has('any');

let lines = [];
try { lines = fs.readFileSync(path.join(TRANSCRIPTS, `${key}.jsonl`), 'utf8').split('\n').filter(Boolean); }
catch { console.error(`recall: no transcript for key "${key}" — run --list`); process.exit(2); }

const turns = [];
let part = 1;
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.role === 'rollover') { part = e.part || part + 1; continue; }
  if ((e.role !== 'user' && e.role !== 'assistant') || !e.text) continue;
  turns.push({ idx: turns.length, part, role: e.role, text: e.text, ts: e.ts || null });
}

const terms = (query.toLowerCase().match(/"[^"]+"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''));
const scoreOf = (text) => { const low = text.toLowerCase(); let h = 0; for (const t of terms) if (low.includes(t)) h++; return h; };

const pool = turns.filter((t) => (onlyPart ? t.part === onlyPart : true));
let matches = pool.map((t) => ({ t, score: scoreOf(t.text) }))
  .filter((m) => (anyMode ? m.score > 0 : terms.length > 0 && m.score === terms.length));

let relaxed = false;
if (!matches.length && !anyMode) {
  relaxed = true;
  matches = pool.map((t) => ({ t, score: scoreOf(t.text) })).filter((m) => m.score > 0);
}
matches.sort((a, b) => b.score - a.score || b.t.idx - a.t.idx);
matches = matches.slice(0, limit);

if (!matches.length) { console.log(`No turns matched "${query}" in ${key}. Try --any, simpler terms, or --list.`); process.exit(0); }

const fmtDate = (ts) => { if (!ts) return ''; try { return ' · ' + new Date(ts).toISOString().slice(0, 10); } catch { return ''; } };
const trim = (s, n) => (s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars — narrow the query to see the full turn]` : s);

console.log(`RECALL — ${matches.length} match${matches.length > 1 ? 'es' : ''} for "${query}" in ${key}${relaxed ? ' (relaxed to ANY-term: no single turn had all terms)' : ''}:\n`);
for (const { t, score } of matches) {
  console.log('─'.repeat(64));
  console.log(`[part ${t.part} · turn ${t.idx}${fmtDate(t.ts)} · matched ${score}/${terms.length} terms]`);
  for (let j = Math.max(0, t.idx - context); j <= Math.min(turns.length - 1, t.idx + context); j++) {
    const a = turns[j];
    const focus = a.idx === t.idx;
    const tag = focus ? (a.role === 'user' ? 'USER▶' : 'ASSISTANT▶') : (a.role === 'user' ? 'user' : 'asst');
    console.log(`${tag}: ${trim(a.text, focus ? 1600 : 360)}`);
  }
  console.log();
}
console.log('─'.repeat(64));
console.log(`(${turns.length} total turns in the archive. --part N to scope · --context N for more neighbours · --any to widen · --limit N.)`);
