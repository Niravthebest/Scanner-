#!/usr/bin/env node
/*
 * Run the backtest from the command line.
 *
 *   node backtest-cli.js dataset.json [--universe=symbols.txt] [--key=value ...]
 *
 * dataset.json: { "SYMBOL": [{date, open, high, low, close, volume}, ...], ... }
 * Any scanner or backtest option can be overridden, e.g.
 *   --startDate=2023-07-01 --riskPct=0.5 --entryMode=close --setupTypes=Pullback,Breakout
 *   --marketFilter=QQQ:21 --benchmarks=SPY,QQQ --trades=trades.csv --json=out.json
 * Alternative strategy (see strategies/): --strategy=minervini [--s.minRs=80 --s.maxStopPct=7 ...]
 */
'use strict';

const fs = require('fs');
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
if (!args._[0]) {
  console.error('usage: node backtest-cli.js dataset.json [--universe=file] [--key=value ...]');
  process.exit(1);
}

const dataset = JSON.parse(fs.readFileSync(args._[0], 'utf8'));
const universe = args.universe
  ? fs.readFileSync(args.universe, 'utf8').split(/\s+/).filter(s => dataset[s])
  : null;

const opts = Object.assign({}, args);
delete opts._; delete opts.universe; delete opts.benchmarks; delete opts.trades; delete opts.json;
if (opts.strategy) {
  const params = {};
  Object.keys(opts).filter(k => k.startsWith('s.')).forEach(k => { params[k.slice(2)] = opts[k]; delete opts[k]; });
  opts.strategy = require(`./strategies/${opts.strategy}.js`).create(params);
}
if (typeof opts.setupTypes === 'string') opts.setupTypes = opts.setupTypes.split(',').map(s => s === 'Gap-up' ? 'Gap-up / EP' : s);
if (typeof opts.marketFilter === 'string') {
  const [symbol, ema] = opts.marketFilter.split(':');
  opts.marketFilter = { symbol, ema: +ema || 21 };
}

const t0 = Date.now();
const res = BT.run(dataset, opts, universe);
const s = res.stats;
const f = (x, d = 1) => (isFinite(x) ? x.toFixed(d) : String(x));

console.log(`Backtest ${s.start} -> ${s.end}  (${((Date.now() - t0) / 1000).toFixed(1)}s, ${universe ? universe.length : Object.keys(dataset).length} symbols)`);
console.log(`Total return ${f(s.totalReturnPct)}%  CAGR ${f(s.cagrPct)}%  Max drawdown ${f(s.maxDrawdownPct)}% (${s.maxDrawdownPeriod.join(' -> ')})`);
console.log(`Avg exposure ${f(s.avgExposurePct)}%  Avg hold ${f(s.avgHoldCalendarDays)} calendar days`);
const line = (name, a) => console.log(
  `${name.padEnd(12)} trades ${String(a.trades).padStart(5)}  win ${f(a.winRate).padStart(5)}%  avgWin ${f(a.avgWinR, 2)}R  avgLoss ${f(a.avgLossR, 2)}R  exp ${f(a.expectancyR, 3)}R  PF ${f(a.profitFactor, 2)}  best ${f(a.bestR, 1)}R`);
line('ALL', s.all);
Object.keys(s.byType).forEach(k => line(k, s.byType[k]));
if (universe) {
  // Equal-weight buy & hold of the same universe: a check on survivorship bias in the symbol list.
  const rets = universe.map(sym => BT.benchmark(dataset[sym], s.start, s.end)).filter(Boolean).map(r => r.totalReturnPct);
  console.log(`Universe equal-weight buy & hold: ${f(rets.reduce((a, b) => a + b, 0) / rets.length)}% (${rets.length} symbols)`);
}
console.log('Yearly: ' + Object.keys(s.yearly).map(y => `${y} ${f(s.yearly[y])}%`).join('  '));

(args.benchmarks ? String(args.benchmarks).split(',') : ['SPY', 'QQQ']).forEach(b => {
  if (!dataset[b]) return;
  const r = BT.benchmark(dataset[b], s.start, s.end);
  console.log(`${b.padEnd(4)} buy & hold: ${f(r.totalReturnPct)}%  CAGR ${f(r.cagrPct)}%  max DD ${f(r.maxDrawdownPct)}%`);
});

if (args.trades) {
  const cols = ['symbol', 'type', 'signalDate', 'entryDate', 'exitDate', 'entry', 'initialStop', 'initialShares', 'pnl', 'rMultiple', 'exitReason'];
  fs.writeFileSync(args.trades, cols.join(',') + '\n' + res.trades.map(t => cols.map(c => t[c]).join(',')).join('\n'));
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify(res));
