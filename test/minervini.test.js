'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BT = require('../backtest.js');
const M = require('../strategies/minervini.js');

function series(n, drift, start) {
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    out.push({ date: d, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 });
    c *= 1 + drift;
  }
  return out;
}

test('sma averages the last n values', () => {
  assert.deepEqual(M.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
});

test('trend template passes a steady uptrend and fails a downtrend', () => {
  const s = M.create();
  const up = { UP: series(300, 0.003, 50), DN: series(300, -0.002, 50) };
  const prep = {};
  Object.keys(up).forEach(k => {
    const idx = {};
    up[k].forEach((b, i) => { idx[b.date] = i; });
    prep[k] = { bars: up[k], idx };
  });
  s.prepare(prep, up.UP.map(b => b.date), ['UP', 'DN']);
  assert.equal(s.trendTemplate(prep.UP, 299), true);
  assert.equal(s.trendTemplate(prep.DN, 299), false);
});

test('backtest strategy hook: signals from the strategy are filled at the trigger with its stop', () => {
  const bars = series(100, 0, 100);
  const strategy = {
    signal: (sym, P, i) => (i === 80 ? { type: 'T', trigger: 100.5, stop: 95, stopPct: 5, rank: 1 } : null)
  };
  const r = BT.run({ X: bars }, { strategy, slippagePct: 0, riskPct: 1, maxPositionPct: 100, maxExposurePct: 100 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entry, 100.5);
  assert.equal(r.trades[0].initialStop, 95);
  assert.equal(r.trades[0].type, 'T');
});

test('partialAtR takes the partial once the close reaches N x initial risk', () => {
  const bars = series(100, 0, 100);
  for (let i = 82; i < 100; i++) bars[i] = Object.assign({}, bars[i], { open: 111, high: 112, low: 110, close: 111 });
  const strategy = { signal: (sym, P, i) => (i === 80 ? { type: 'T', trigger: 100, stop: 95, stopPct: 5 } : null) };
  const r = BT.run({ X: bars }, { strategy, slippagePct: 0, riskPct: 1, maxPositionPct: 100, maxExposurePct: 100, partialAtR: 2, partialFraction: 0.5, trailEma: 5, trailAfterDays: 100, maxHoldDays: 100 });
  const t = r.trades[0];
  assert.ok(t.realized > 0);
  assert.equal(t.exitReason, 'end of test');
});
