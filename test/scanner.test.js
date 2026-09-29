'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scanner.js');
const D = require('../data.js');

const END = new Date('2026-09-29T00:00:00Z');

function flatBars(n, price, volume) {
  return Array.from({ length: n }, (_, i) => ({
    date: 'd' + i,
    open: price,
    high: price * 1.02,
    low: price * 0.98,
    close: price,
    volume: volume || 1e6
  }));
}

test('ema seeds with the SMA and then smooths', () => {
  const e = S.ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3); // 4 * 0.5 + 2 * 0.5
  assert.equal(e[4], 4);
});

test('relative volume compares today with the prior average', () => {
  const bars = flatBars(21, 10, 100);
  bars[20].volume = 300;
  assert.equal(S.relativeVolume(bars, 20, 20), 3);
});

test('anchored VWAP weights typical price by volume', () => {
  const bars = [
    { high: 11, low: 9, close: 10, volume: 1 },
    { high: 22, low: 18, close: 20, volume: 3 }
  ];
  assert.equal(S.anchoredVwap(bars, 0, 1), 17.5);
});

test('position size risks the chosen % of the account', () => {
  const s = S.positionSize({ accountSize: 100000, riskPct: 0.5, maxPositionPct: 100, entry: 50, stop: 48.5 });
  assert.equal(s.shares, 333); // $500 risk / $1.50 per share
  assert.ok(Math.abs(s.stopPct - 3) < 1e-9);
  assert.equal(s.cappedBy, 'risk');
  assert.ok(s.dollarRisk <= 500);
});

test('position size respects the max position cap', () => {
  const s = S.positionSize({ accountSize: 100000, riskPct: 1, maxPositionPct: 20, entry: 100, stop: 99.5 });
  assert.equal(s.shares, 200); // risk alone would allow 2000 shares
  assert.equal(s.cappedBy, 'position cap');
  assert.equal(s.positionPct, 20);
});

test('position size rejects a stop at or above entry', () => {
  assert.equal(S.positionSize({ accountSize: 1e4, riskPct: 1, entry: 10, stop: 10 }).valid, false);
  assert.equal(S.positionSize({ accountSize: 1e4, riskPct: 1, entry: 10, stop: 11 }).valid, false);
});

test('analyze returns null with too little history', () => {
  assert.equal(S.analyze('X', flatBars(S.MIN_BARS - 1, 10), {}), null);
});

test('liquidity, price and ADR filters block setups', () => {
  const r = S.analyze('X', flatBars(80, 2, 1000), {});
  assert.deepEqual(r.failedFilters.sort(), ['liquidity', 'price']);
  assert.equal(r.best, null);
});

test('demo data triggers each setup type and flags the wide stop', () => {
  const ds = D.demoDataset(42, END);
  const { results } = S.scan(ds, {});
  const by = Object.fromEntries(results.map(r => [r.symbol, r]));

  assert.equal(by.XGAP.best.type, 'Gap-up / EP');
  assert.equal(by.XGAP.best.wideStop, false);

  assert.equal(by.XPULL.best.type, 'Pullback');
  assert.ok(by.XPULL.best.support);

  assert.ok(by.XBASE.setups.some(s => s.type === 'Breakout'));

  assert.ok(by.XWIDE.setups.some(s => s.type === 'Gap-up / EP'));
  assert.equal(by.XWIDE.best.wideStop, true);

  assert.deepEqual(by.XPENNY.failedFilters, ['price']);
  assert.deepEqual(by.XTHIN.failedFilters, ['liquidity']);
  assert.deepEqual(by.XFLAT.failedFilters, ['ADR']);
  assert.equal(by.XDOWN.best, null);

  // Actionable setups sort before wide stops and non-setups.
  const firstWide = results.findIndex(r => r.best && r.best.wideStop);
  const firstNone = results.findIndex(r => !r.best);
  assert.ok(results.slice(0, firstWide).every(r => r.best && !r.best.wideStop));
  assert.ok(firstWide < firstNone);
});

test('demo setups hold across seeds', () => {
  for (const seed of [1, 7, 99, 2026, 123456]) {
    const { results } = S.scan(D.demoDataset(seed, END), {});
    const types = new Set(results.flatMap(r => r.setups.map(s => s.type)));
    assert.ok(types.has('Gap-up / EP') && types.has('Pullback') && types.has('Breakout'), 'seed ' + seed);
  }
});

test('a gap-up day is not also reported as a pullback', () => {
  const ds = D.demoDataset(42, END);
  const bars = ds.XPULL.slice();
  const prev = bars[bars.length - 2].close;
  // Same flush-and-reclaim day, but opening 10% above the prior close.
  bars[bars.length - 1] = Object.assign({}, bars[bars.length - 1], { open: prev * 1.1, high: prev * 1.15 });
  const r = S.analyze('X', bars, {});
  assert.ok(!r.setups.some(s => s.type === 'Pullback'));
});

test('stop sizing uses the configured account and risk', () => {
  const ds = D.demoDataset(42, END);
  const r = S.analyze('XGAP', ds.XGAP, { accountSize: 50000, riskPct: 1, maxPositionPct: 100 });
  const s = r.best.size;
  assert.ok(s.dollarRisk <= 500 && s.dollarRisk > 480);
});

test('plan summary flags exposure over the cap', () => {
  const sum = S.planSummary(
    [{ positionValue: 2000, dollarRisk: 50 }, { positionValue: 2000, dollarRisk: 50 }],
    { accountSize: 10000, maxExposurePct: 35 }
  );
  assert.equal(sum.exposurePct, 40);
  assert.equal(sum.overCap, true);
  assert.equal(sum.riskPct, 1);
});

test('parseCsv groups by symbol, sorts by date and reports bad rows', () => {
  const csv = [
    'Ticker,Date,Open,High,Low,Close,Volume',
    'abc,2026-01-03,11,12,10,11.5,1000',
    'ABC,2026-01-02,10,11,9,10.5,900',
    'XYZ,2026-01-02,5,6,4,5.5,100',
    'XYZ,2026-01-03,oops,6,4,5.5,100'
  ].join('\n');
  const { dataset, errors } = D.parseCsv(csv);
  assert.deepEqual(Object.keys(dataset).sort(), ['ABC', 'XYZ']);
  assert.deepEqual(dataset.ABC.map(b => b.date), ['2026-01-02', '2026-01-03']);
  assert.equal(dataset.XYZ.length, 1);
  assert.equal(errors.length, 1);
});

test('parseCsv uses the fallback symbol and reports missing columns', () => {
  const ok = D.parseCsv('date,open,high,low,close,volume\n2026-01-02,1,2,1,2,5', 'FILE');
  assert.deepEqual(Object.keys(ok.dataset), ['FILE']);
  const bad = D.parseCsv('date,close\n2026-01-02,1');
  assert.match(bad.errors[0], /Missing column/);
});

test('parseSymbols normalises and de-duplicates', () => {
  assert.deepEqual(D.parseSymbols('nvda, PLTR;brk.b\nnvda  $$$'), ['NVDA', 'PLTR', 'BRK.B']);
});

test('fetchPolygon maps aggregates to bars', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ t: Date.UTC(2026, 0, 2), o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }] })
    };
  };
  const { dataset, errors } = await D.fetchPolygon(['AAA', 'BBB'], 'k', { delayMs: 0, fetch: fakeFetch });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/v2\/aggs\/ticker\/AAA\/range\/1\/day\//);
  assert.deepEqual(dataset.AAA, [{ date: '2026-01-02', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }]);
  assert.deepEqual(errors, []);
});

test('fetchPolygon records HTTP errors per symbol', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const { dataset, errors } = await D.fetchPolygon(['AAA'], 'k', { delayMs: 0, fetch: fakeFetch });
  assert.deepEqual(dataset, {});
  assert.deepEqual(errors, ['AAA: HTTP 403']);
});
