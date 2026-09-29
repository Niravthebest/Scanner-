'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../data.js');
const BT = require('../backtest.js');

const END = new Date('2026-09-29T00:00:00Z');

// A known gap-up signal on the last demo bar, followed by scripted days.
function scenario(nextDays) {
  const bars = D.demoDataset(42, END).XGAP.slice();
  const sig = bars[bars.length - 1];
  const extra = nextDays(sig);
  const dates = D.tradingDays(bars.length + extra.length + 5, new Date('2026-12-31T00:00:00Z'));
  const all = bars.concat(extra).map((b, i) => Object.assign({}, b, { date: dates[i] }));
  return { bars: all, signalDate: all[bars.length - 1].date, trigger: sig.high, stop: sig.low };
}

function runScenario(s, opts) {
  return BT.run({ XGAP: s.bars }, Object.assign({
    startDate: s.signalDate,
    setupTypes: ['Gap-up / EP'],
    slippagePct: 0,
    maxPositionPct: 100,
    maxExposurePct: 100
  }, opts));
}

const day = (open, high, low, close) => ({ open, high, low, close, volume: 2e6 });

test('breakout entry fills at the trigger and a stop costs about 1R', () => {
  const s = scenario(sig => [
    day(sig.close, sig.high * 1.01, sig.close * 0.995, sig.high * 1.005),
    day(sig.high, sig.high * 1.002, sig.low * 0.99, sig.low * 0.995)
  ]);
  const r = runScenario(s);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.ok(Math.abs(t.entry - s.trigger) < 1e-9);
  assert.equal(t.exitReason, 'stop');
  assert.ok(Math.abs(t.rMultiple + 1) < 1e-9);
});

test('a gap below the stop fills at the open (worse than 1R)', () => {
  const s = scenario(sig => [
    day(sig.close, sig.high * 1.01, sig.close * 0.995, sig.high * 1.005),
    day(sig.low * 0.9, sig.low * 0.92, sig.low * 0.88, sig.low * 0.9)
  ]);
  const t = runScenario(s).trades[0];
  assert.equal(t.exitReason, 'stop (gap)');
  assert.ok(t.rMultiple < -1.5);
});

test('touching entry and stop on the same day is treated as a loss', () => {
  const s = scenario(sig => [day(sig.close, sig.high * 1.01, sig.low * 0.99, sig.close)]);
  const t = runScenario(s).trades[0];
  assert.equal(t.exitReason, 'stop (same day)');
  assert.ok(Math.abs(t.rMultiple + 1) < 1e-9);
});

test('no fill when price never reaches the trigger', () => {
  const s = scenario(sig => [day(sig.close, sig.high * 0.999, sig.close * 0.99, sig.close)]);
  assert.equal(runScenario(s).trades.length, 0);
});

test('winner: partial after 3 days, stop to breakeven, trail exit', () => {
  const s = scenario(sig => {
    const out = [day(sig.close, sig.high * 1.02, sig.close * 0.998, sig.high * 1.015)];
    let c = sig.high * 1.015;
    for (let k = 0; k < 6; k++) {
      const n = c * 1.03;
      out.push(day(c * 1.005, n * 1.005, c * 0.999, n));
      c = n;
    }
    out.push(day(c, c * 1.001, c * 0.84, c * 0.85)); // close far below the 10 EMA
    return out;
  });
  const r = runScenario(s);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.partialDone, true);
  assert.ok(t.stop >= t.entry, 'stop moved to breakeven');
  assert.ok(['trail', 'breakeven stop'].includes(t.exitReason));
  assert.ok(t.rMultiple > 1, 'R ' + t.rMultiple);
});

test('position size risks the configured share of equity', () => {
  const s = scenario(sig => [
    day(sig.close, sig.high * 1.01, sig.close * 0.995, sig.high * 1.005),
    day(sig.high, sig.high * 1.002, sig.low * 0.99, sig.low * 0.995)
  ]);
  const r = runScenario(s, { riskPct: 1, initialEquity: 100000 });
  const t = r.trades[0];
  assert.ok(t.initialRisk <= 1000 && t.initialRisk > 990, 'risk ' + t.initialRisk);
});

test('position cap limits size', () => {
  const s = scenario(sig => [
    day(sig.close, sig.high * 1.01, sig.close * 0.995, sig.high * 1.005),
    day(sig.high, sig.high * 1.002, sig.low * 0.99, sig.low * 0.995)
  ]);
  const t = runScenario(s, { riskPct: 5, maxPositionPct: 10, initialEquity: 100000 }).trades[0];
  assert.ok(t.initialShares * t.entry <= 10000 + 1e-6);
});

test('stats and benchmark are computed', () => {
  const s = scenario(sig => [
    day(sig.close, sig.high * 1.01, sig.close * 0.995, sig.high * 1.005),
    day(sig.high, sig.high * 1.002, sig.low * 0.99, sig.low * 0.995)
  ]);
  const r = runScenario(s);
  assert.equal(r.stats.all.trades, 1);
  assert.equal(r.stats.all.winRate, 0);
  assert.ok(r.stats.maxDrawdownPct < 0);
  const b = BT.benchmark(s.bars, s.bars[0].date, s.bars[s.bars.length - 1].date);
  assert.ok(isFinite(b.totalReturnPct));
});
