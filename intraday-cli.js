#!/usr/bin/env node
/*
 * Intraday-entry backtest workflow:
 *   1. node intraday-cli.js candidates --daily=daily.json --from=2021-01-04 --to=2026-09-28 --out=candidates.json
 *   2. node tools/massive.js intraday --candidates=candidates.json --out=intraday.json
 *   3. node intraday-cli.js run --daily=daily.json --candidates=candidates.json --intraday=intraday.json
 *        [--riskPct=0.5 --orMinutes=5 --maxExposurePct=100 --trailEma=10 --trades=trades.csv]
 */
'use strict';

const fs = require('fs');
const IB = require('./intraday-backtest.js');
const BT = require('./backtest.js');

function parseArgs(argv) {
  const out = { _: [] };
  argv.forEach(a => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (!m) return out._.push(a);
    const v = m[2];
    out[m[1]] = v === 'true' ? true : v === 'false' ? false : v !== '' && !isNaN(+v) ? +v : v;
  });
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const load = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const f = (x, d = 1) => (isFinite(x) ? x.toFixed(d) : String(x));

if (cmd === 'candidates') {
  const daily = load(args.daily);
  const ref = daily[args.calendar || 'SPY'];
  const dates = ref.map(b => b.date).filter(d => d >= args.from && d <= args.to);
  const universe = args.universe ? fs.readFileSync(args.universe, 'utf8').split(/\s+/).filter(s => daily[s]) : null;
  const opts = Object.assign({}, args);
  if (typeof opts.setupTypes === 'string') opts.setupTypes = opts.setupTypes.split(',');
  const c = IB.buildCandidates(daily, dates, opts, universe);
  const n = Object.values(c).reduce((s, l) => s + l.length, 0);
  fs.writeFileSync(args.out, JSON.stringify(c));
  console.log(`${n} candidate stock-days over ${Object.keys(c).length} days -> ${args.out}`);
} else if (cmd === 'run') {
  const daily = load(args.daily);
  const cands = load(args.candidates);
  const intraday = load(args.intraday);
  const res = IB.run(daily, intraday, cands, args);
  const s = res.stats;
  console.log(`Intraday backtest ${s.start} -> ${s.end}`);
  console.log(`Total ${f(s.totalReturnPct)}%  CAGR ${f(s.cagrPct)}%  Max DD ${f(s.maxDrawdownPct)}%  Avg exposure ${f(s.avgExposurePct)}%  Median stop ${f(s.medianStopPct, 2)}%`);
  console.log('Funnel:', JSON.stringify(res.counts));
  const line = (name, a) => console.log(`${name.padEnd(12)} trades ${String(a.trades).padStart(5)}  win ${f(a.winRate).padStart(5)}%  avgWin ${f(a.avgWinR, 2)}R  avgLoss ${f(a.avgLossR, 2)}R  exp ${f(a.expectancyR, 3)}R  PF ${f(a.profitFactor, 2)}  top5 ${f(a.top5PctOfProfit, 0)}%`);
  line('ALL', s.all);
  Object.keys(s.byType).forEach(k => line(k, s.byType[k]));
  ['SPY', 'QQQ'].forEach(b => {
    if (!daily[b]) return;
    const r = BT.benchmark(daily[b], s.start, s.end);
    console.log(`${b} buy & hold: ${f(r.totalReturnPct)}%  max DD ${f(r.maxDrawdownPct)}%`);
  });
  if (args.trades) {
    const cols = ['symbol', 'type', 'entryDate', 'entryMinute', 'exitDate', 'entry', 'initialStop', 'initialShares', 'pnl', 'rMultiple', 'exitReason'];
    fs.writeFileSync(args.trades, cols.join(',') + '\n' + res.trades.map(t => cols.map(c => t[c]).join(',')).join('\n'));
  }
} else {
  console.error('usage: node intraday-cli.js candidates|run [--options]');
  process.exit(1);
}
