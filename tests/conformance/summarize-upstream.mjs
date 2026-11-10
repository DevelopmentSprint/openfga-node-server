// Summarises `go test -json` output of the upstream suites: leaf counts by suite and feature,
// and the first lines of every failing leaf. Usage: node summarize-upstream.mjs <file.jsonl>
import { readFileSync } from 'node:fs';
const events = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const out = new Map(); const status = new Map();
for (const e of events) {
  if (!e.Test) continue;
  if (e.Action === 'output') out.set(e.Test, (out.get(e.Test) ?? '') + e.Output);
  if (['pass', 'fail', 'skip'].includes(e.Action)) status.set(e.Test, e.Action);
}
const names = [...status.keys()];
const leaves = names.filter((n) => !names.some((m) => m.startsWith(n + '/')));
const suiteOf = (n) => n.split('/')[0].replace('TestExternal', '');
const featureOf = (n) => {
  const l = n.toLowerCase();
  if (l.includes('inline_expression')) return 'inline-expressions (experimental)';
  if (/condition|abac|cel|timestamp|duration|ipaddress|context/.test(l)) return 'conditions';
  return 'core-model';
};
const by = {}; const failures = [];
for (const n of leaves) {
  const s = status.get(n); const key = `${suiteOf(n)} | ${featureOf(n)}`;
  by[key] ??= { pass: 0, fail: 0, skip: 0 }; by[key][s]++;
  if (s === 'fail') {
    const o = out.get(n) ?? '';
    const err = (o.match(/Error:\s+([\s\S]*?)\n\s+(?:Test|Messages):/) ?? [, o.slice(0, 300)])[1].replace(/\s+/g, ' ').trim().slice(0, 300);
    failures.push({ test: n.replace(/^TestExternal/, ''), error: err });
  }
}
const totals = { pass: 0, fail: 0, skip: 0 };
for (const v of Object.values(by)) for (const k of Object.keys(totals)) totals[k] += v[k];
console.log(JSON.stringify({ leaves: leaves.length, totals, by, failures }, null, 1));
