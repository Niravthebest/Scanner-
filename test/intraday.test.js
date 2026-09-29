'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const IB = require('../intraday-backtest.js');

const bar = (t, open, high, low, close) => ({ t, open, high, low, close, volume: 1000 });
const O = Object.assign({}, IB.DEFAULTS, { slippagePct: 0 });

test('findEntry buys one tick above the opening-range high with stop below the low of day', () => {
  const bars = [bar(0, 100, 101, 99, 100.5), bar(5, 100.5, 100.8, 99.5, 100.6), bar(10, 100.6, 102, 100.4, 101.8)];
  const e = IB.findEntry(bars, { adrPct: 5 }, O);
  assert.equal(e.k, 2);
  assert.ok(Math.abs(e.entry - 101.01) < 1e-9);
  assert.ok(Math.abs(e.stop - 98.99) < 1e-9);
});

test('findEntry fills at the open when the bar gaps over the trigger', () => {
  const bars = [bar(0, 100, 101, 99, 100.5), bar(5, 101.5, 102, 101.4, 101.9)];
  const e = IB.findEntry(bars, { adrPct: 5 }, O);
  assert.equal(e.entry, 101.5);
});

test('findEntry skips stops wider than the ADR limit', () => {
  const bars = [bar(0, 100, 101, 95, 100.5), bar(5, 100.5, 102, 100, 101.8)];
  const e = IB.findEntry(bars, { adrPct: 3 }, O);
  assert.equal(e.skipped, 'wide');
});

test('findEntry ignores breaks after the entry window', () => {
  const bars = [bar(0, 100, 101, 99, 100.5), bar(200, 100.5, 102, 100, 101.8)];
  assert.equal(IB.findEntry(bars, { adrPct: 5 }, O), null);
});

test('sameDayStop catches a stop on the entry bar or later', () => {
  const bars = [bar(0, 100, 101, 99, 100.5), bar(5, 100.5, 102, 98.5, 101), bar(10, 101, 101.5, 100.5, 101)];
  assert.equal(IB.sameDayStop(bars, 1, 98.99), 98.99);
  assert.equal(IB.sameDayStop(bars, 2, 98.99), null);
});

function dailySeries(n, start) {
  const out = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    out.push({ date: d, open: c, high: c * 1.03, low: c * 0.97, close: c * 1.005, volume: 5e6 });
    c *= 1.005;
  }
  return out;
}

test('run: filled trade stopped the same day loses about 1R', () => {
  const daily = { XYZ: dailySeries(80, 50) };
  const d = daily.XYZ[70].date;
  const px = daily.XYZ[70].open;
  const intraday = { XYZ: { [d]: [bar(0, px, px * 1.01, px * 0.99, px), bar(5, px, px * 1.02, px * 0.985, px)] } };
  const cands = { [d]: [{ symbol: 'XYZ', type: 'Pullback', adrPct: 6 }] };
  const r = IB.run(daily, intraday, cands, { slippagePct: 0, startDate: daily.XYZ[60].date });
  assert.equal(r.counts.filled, 1);
  assert.equal(r.trades[0].exitReason, 'stop (same day)');
  assert.ok(Math.abs(r.trades[0].rMultiple + 1) < 1e-9);
});

test('run: candidate without intraday data is counted and skipped', () => {
  const daily = { XYZ: dailySeries(80, 50) };
  const d = daily.XYZ[70].date;
  const r = IB.run(daily, {}, { [d]: [{ symbol: 'XYZ', type: 'Pullback', adrPct: 6 }] }, {});
  assert.equal(r.counts.noIntraday, 1);
  assert.equal(r.trades.length, 0);
});

test('buildCandidates uses only data before the day (plus the open for gaps)', () => {
  const daily = { XYZ: dailySeries(120, 50) };
  const i = 100;
  const d = daily.XYZ[i].date;
  const before = IB.buildCandidates(daily, [d], { minGapAdrPct: 0 });
  // Changing today's close/high/low must not change today's candidates.
  daily.XYZ[i] = Object.assign({}, daily.XYZ[i], { close: 1, high: 999, low: 0.5 });
  const after = IB.buildCandidates(daily, [d], { minGapAdrPct: 0 });
  assert.deepEqual(after, before);
});
