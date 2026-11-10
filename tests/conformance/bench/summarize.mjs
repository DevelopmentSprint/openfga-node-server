// Prints a comparison table from results/bench-*.json.  node summarize.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
const rows = readdirSync(dir).filter((f) => /^bench-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
rows.sort((a, b) => a.size - b.size || a.engine.localeCompare(b.engine));
const ops = ['check_cold', 'check_warm_repeat', 'check_warm_fresh', 'check_warm_concurrency8', 'batch50_cold', 'batch50_warm_repeat', 'batch50_warm_fresh', 'list_objects_first_pass', 'list_objects_warm_repeat', 'list_objects_warm_fresh'];
console.log('| size | operation | engine | p50 | p95 | p99 | max | errors |\n|---|---|---|---|---|---|---|---|');
for (const size of [...new Set(rows.map((r) => r.size))]) for (const op of ops) for (const r of rows.filter((x) => x.size === size)) { const l = r.latency_ms[op]; console.log(`| ${size} | ${op} | ${r.engine} | ${l.p50} | ${l.p95} | ${l.p99} | ${l.max} | ${l.errors} |`); }
console.log('\n| size | engine | tuples | load s | load tuples/s | check decisions sha | batch decisions sha | ListObjects result size (mean) |\n|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.size} | ${r.engine} | ${r.load.tuples} | ${r.load.seconds} | ${r.load.tuples_per_second} | ${r.check_decisions_sha256.slice(0, 10)} | ${r.batch_decisions_sha256.slice(0, 10)} | ${r.list_objects_result_size.mean} |`);
