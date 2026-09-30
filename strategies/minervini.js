/*
 * Minervini SEPA-style strategy for backtest.js (opts.strategy).
 *
 * Mark Minervini won the U.S. Investing Championship in 1997 and set the
 * $1M+ stock-division record (+334.8%) in 2021; his rules are published in
 * "Trade Like a Stock Market Wizard". This is a daily-bar approximation:
 *
 *   Trend Template (all must hold at the signal close)
 *     close > SMA50 > SMA150 > SMA200, SMA200 rising over 1 month,
 *     close >= 30% above the 52-week low and within 25% of the 52-week high,
 *     relative strength rank >= minRs (percentile of a weighted 3/6/9/12-month
 *     return across the trade universe on that day).
 *   Tight base (volatility contraction)
 *     the last baseDays bars span <= maxBaseRangePct, the base's range is tighter
 *     than the prior baseDays bars (contraction), volume dried up
 *     (baseDays avg < 50-day avg), and the close is within nearPivotPct of the pivot.
 *   Entry: buy-stop one tick above the pivot (base high) the next day.
 *   Stop: base low, but never more than maxStopPct below the pivot.
 *
 * Exits come from backtest.js options (partialAtR, trailEma, maxHoldDays).
 * Only data up to and including the signal day is used.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    minPrice: 10,
    minAvgDollarVolM: 10,
    minRs: 70,
    baseDays: 10,
    maxBaseRangePct: 12,
    nearPivotPct: 3,
    maxStopPct: 8,
    minStopPct: 2 // floor so one-bar noise doesn't set an unrealistically tight stop
  };

  function sma(values, n) {
    var out = new Array(values.length).fill(null);
    var s = 0;
    for (var i = 0; i < values.length; i++) {
      s += values[i];
      if (i >= n) s -= values[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  function create(params) {
    var c = {};
    Object.keys(DEFAULTS).forEach(function (k) { c[k] = params && params[k] !== undefined ? +params[k] : DEFAULTS[k]; });

    function prepare(prepared, calendar, symbols) {
      // Per-symbol indicator arrays.
      symbols.forEach(function (sym) {
        var P = prepared[sym];
        var closes = P.bars.map(function (b) { return b.close; });
        var vols = P.bars.map(function (b) { return b.volume; });
        var dv = P.bars.map(function (b) { return b.close * b.volume; });
        P.m = { s50: sma(closes, 50), s150: sma(closes, 150), s200: sma(closes, 200), v50: sma(vols, 50), dv50: sma(dv, 50) };
        P.m.rsRaw = closes.map(function (x, i) {
          if (i < 252) return null;
          var r = function (n) { return x / closes[i - n] - 1; };
          return 0.4 * r(63) + 0.2 * r(126) + 0.2 * r(189) + 0.2 * r(252);
        });
      });
      // Cross-sectional RS percentile per date.
      var rs = {};
      calendar.forEach(function (date) {
        var list = [];
        symbols.forEach(function (sym) {
          var P = prepared[sym];
          var i = P.idx[date];
          if (i !== undefined && P.m.rsRaw[i] !== null) list.push([sym, P.m.rsRaw[i]]);
        });
        list.sort(function (a, b) { return a[1] - b[1]; });
        var map = {};
        list.forEach(function (e, k) { map[e[0]] = list.length > 1 ? (k / (list.length - 1)) * 99 : 50; });
        rs[date] = map;
      });
      return { rs: rs };
    }

    function trendTemplate(P, i) {
      var m = P.m;
      var b = P.bars[i];
      if (i < 252 || m.s200[i] === null || m.s200[i - 22] === null) return false;
      if (!(b.close > m.s50[i] && m.s50[i] > m.s150[i] && m.s150[i] > m.s200[i])) return false;
      if (!(m.s200[i] > m.s200[i - 22])) return false;
      var hi = -Infinity;
      var lo = Infinity;
      for (var k = i - 251; k <= i; k++) { hi = Math.max(hi, P.bars[k].high); lo = Math.min(lo, P.bars[k].low); }
      return b.close >= lo * 1.3 && b.close >= hi * 0.75;
    }

    function signal(sym, P, i, ctx) {
      var b = P.bars[i];
      var m = P.m;
      if (!m || b.close < c.minPrice || !(m.dv50[i] >= c.minAvgDollarVolM * 1e6)) return null;
      var rsRank = ctx.rs[b.date] && ctx.rs[b.date][sym];
      if (rsRank === undefined || rsRank < c.minRs) return null;
      if (!trendTemplate(P, i)) return null;

      var n = c.baseDays;
      var hi = -Infinity;
      var lo = Infinity;
      var vol = 0;
      for (var k = i - n + 1; k <= i; k++) { hi = Math.max(hi, P.bars[k].high); lo = Math.min(lo, P.bars[k].low); vol += P.bars[k].volume; }
      var phi = -Infinity;
      var plo = Infinity;
      for (var q = i - 2 * n + 1; q <= i - n; q++) { phi = Math.max(phi, P.bars[q].high); plo = Math.min(plo, P.bars[q].low); }
      var range = (hi / lo - 1) * 100;
      var priorRange = (phi / plo - 1) * 100;
      if (range > c.maxBaseRangePct || range >= priorRange) return null; // must be tight and contracting
      if (!(vol / n < m.v50[i])) return null; // volume dry-up
      if (b.close < hi * (1 - c.nearPivotPct / 100)) return null; // near the pivot

      var trigger = hi + 0.01;
      var stop = Math.max(lo - 0.01, trigger * (1 - c.maxStopPct / 100));
      stop = Math.min(stop, trigger * (1 - c.minStopPct / 100));
      return { type: 'SEPA breakout', trigger: trigger, stop: stop, stopPct: (1 - stop / trigger) * 100, rank: rsRank };
    }

    return { name: 'minervini', params: c, prepare: prepare, signal: signal, trendTemplate: trendTemplate };
  }

  var api = { DEFAULTS: DEFAULTS, create: create, sma: sma };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Minervini = api;
})(typeof window !== 'undefined' ? window : this);
