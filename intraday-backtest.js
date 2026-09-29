/*
 * Intraday-entry backtest (Luk-style execution).
 *
 * Candidates for day D are chosen without look-ahead:
 *   - Pullback / Breakout: the daily scanner flagged the stock at D-1's close,
 *     restricted to a momentum focus list (top N by 3-month return, or ADR >= minFocusAdrPct).
 *   - Gap-up / EP: the stock opens >= minGapPct above D-1's close (known at 9:30).
 * Entry on day D: buy-stop one tick above the opening-range high (first orMinutes).
 * Stop: the low of the day up to the bar before entry (never wider than maxStopPct or
 * maxStopAdr x ADR, otherwise the trade is skipped). If the entry bar or any later bar
 * that day trades at the stop, the trade is stopped out (worst case within a bar).
 * From D+1 the position is managed on daily bars: gap-downs fill at the open, partial
 * after partialDays with stop to breakeven, rest exits on a close below the trailing EMA.
 *
 * Inputs:
 *   daily:    { SYM: [{date, open, high, low, close, volume}] }
 *   intraday: { SYM: { 'YYYY-MM-DD': [{t, open, high, low, close, volume}] } }
 *             t = minutes after 09:30 ET of the bar start (0, 5, 10, ... or 0, 1, 2, ...)
 */
(function (root) {
  'use strict';

  var node = typeof module !== 'undefined' && module.exports;
  var S = node ? require('./scanner.js') : root.Scanner;
  var BT = node ? require('./backtest.js') : root.Backtest;

  var DEFAULTS = {
    startDate: null,
    endDate: null,
    initialEquity: 100000,
    riskPct: 0.5,
    maxPositionPct: 20,
    maxExposurePct: 100,
    orMinutes: 5,
    entryWindowMinutes: 120, // only take opening-range breaks in the first 2 hours
    tick: 0.01,
    maxStopPct: 6,
    maxStopAdr: 1, // stop no wider than 1 x ADR
    maxChasePct: 2, // skip if the breakout bar opens this far above the trigger
    slippagePct: 0.05,
    partialDays: 3,
    partialFraction: 1 / 3,
    trailEma: 10,
    maxHoldDays: 60,
    // Candidate selection
    focusTopN: 50,
    focusLookback: 63,
    minFocusAdrPct: 4,
    minGapPct: 4,
    minGapAdrPct: 3,
    setupTypes: null,
    scannerOpts: { minPriorRunPct: 40 }
  };

  function withDefaults(opts) {
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = opts && opts[k] !== undefined ? opts[k] : DEFAULTS[k]; });
    return o;
  }

  function slip(p, pct, dir) { return p * (1 + dir * pct / 100); }

  function indexDaily(daily) {
    var idx = {};
    Object.keys(daily).forEach(function (s) {
      idx[s] = {};
      daily[s].forEach(function (b, i) { idx[s][b.date] = i; });
    });
    return idx;
  }

  /**
   * Candidates per date (no look-ahead). Returns { date: [{symbol, type, adrPct, gapPct}] }.
   */
  function buildCandidates(daily, dates, opts, universe) {
    var o = withDefaults(opts);
    var idx = indexDaily(daily);
    var syms = (universe || Object.keys(daily)).filter(function (s) { return daily[s]; });
    var out = {};
    dates.forEach(function (d) {
      var perf = [];
      syms.forEach(function (s) {
        var i = idx[s][d];
        if (i === undefined || i <= o.focusLookback) return;
        perf.push([s, daily[s][i - 1].close / daily[s][i - 1 - o.focusLookback].close - 1]);
      });
      perf.sort(function (a, b) { return b[1] - a[1]; });
      var top = {};
      perf.slice(0, o.focusTopN).forEach(function (p) { top[p[0]] = true; });

      var list = [];
      syms.forEach(function (s) {
        var i = idx[s][d];
        if (i === undefined || i < S.MIN_BARS + 1) return;
        var bars = daily[s];
        var hist = bars.slice(Math.max(0, i - 200), i); // up to yesterday's close
        var base = S.analyze(s, hist, {});
        if (!base || base.failedFilters.length) return;
        var adr = base.metrics.adrPct;
        var r = S.analyze(s, hist, o.scannerOpts);
        var types = r ? r.setups.map(function (x) { return x.type; }).filter(function (t) { return t !== 'Gap-up / EP'; }) : [];
        if (o.setupTypes) types = types.filter(function (t) { return o.setupTypes.indexOf(t) !== -1; });
        if (types.length && (top[s] || adr >= o.minFocusAdrPct)) {
          list.push({ symbol: s, type: types[0], adrPct: adr, focus: !!top[s] });
          return;
        }
        var gap = (bars[i].open / bars[i - 1].close - 1) * 100; // known at the open
        if (gap >= o.minGapPct && adr >= o.minGapAdrPct && (!o.setupTypes || o.setupTypes.indexOf('Gap-up / EP') !== -1)) {
          list.push({ symbol: s, type: 'Gap-up / EP', adrPct: adr, gapPct: gap, focus: !!top[s] });
        }
      });
      if (list.length) out[d] = list;
    });
    return out;
  }

  /** Find the opening-range-high break. Returns null if it never triggers or is skipped. */
  function findEntry(bars, cand, o) {
    var orBars = bars.filter(function (b) { return b.t < o.orMinutes; });
    if (!orBars.length) return null;
    var orHigh = Math.max.apply(null, orBars.map(function (b) { return b.high; }));
    var lod = Math.min.apply(null, orBars.map(function (b) { return b.low; }));
    var trigger = orHigh + o.tick;
    for (var k = 0; k < bars.length; k++) {
      var b = bars[k];
      if (b.t < o.orMinutes) continue;
      if (b.t >= o.entryWindowMinutes) return null;
      if (b.high >= trigger) {
        if (b.open > trigger * (1 + o.maxChasePct / 100)) return { skipped: 'chase' };
        var entry = slip(Math.max(b.open, trigger), o.slippagePct, 1);
        var stop = lod - o.tick;
        var stopPct = (entry - stop) / entry * 100;
        if (stopPct > o.maxStopPct || (cand.adrPct && stopPct > o.maxStopAdr * cand.adrPct)) return { skipped: 'wide', stopPct: stopPct };
        return { k: k, t: b.t, entry: entry, stop: stop, stopPct: stopPct, orHigh: orHigh };
      }
      lod = Math.min(lod, b.low);
    }
    return null;
  }

  /** After entry on bar k: first stop hit that day, or null. Entry bar is checked too (worst case). */
  function sameDayStop(bars, k, stop) {
    for (var j = k; j < bars.length; j++) {
      var b = bars[j];
      if (j > k && b.open <= stop) return b.open;
      if (b.low <= stop) return stop;
    }
    return null;
  }

  function run(daily, intraday, candidates, opts) {
    var o = withDefaults(opts);
    var idx = indexDaily(daily);
    var trailCache = {};
    function trail(s) {
      if (!trailCache[s]) trailCache[s] = S.ema(daily[s].map(function (b) { return b.close; }), o.trailEma);
      return trailCache[s];
    }
    var dates = Object.keys(candidates).concat(daily.SPY ? daily.SPY.map(function (b) { return b.date; }) : [])
      .filter(function (d, i, a) { return a.indexOf(d) === i; })
      .filter(function (d) { return (!o.startDate || d >= o.startDate) && (!o.endDate || d <= o.endDate); })
      .sort();

    var cash = o.initialEquity;
    var positions = [];
    var trades = [];
    var curve = [];
    var counts = { candidates: 0, noIntraday: 0, noTrigger: 0, skippedWide: 0, skippedChase: 0, noRoom: 0, filled: 0, stoppedSameDay: 0 };
    var lastClose = {};

    function mark() {
      var v = 0;
      positions.forEach(function (p) { v += p.shares * (lastClose[p.symbol] || p.entry); });
      return v;
    }
    function closePart(p, shares, price, date, reason) {
      var fill = slip(price, o.slippagePct, -1);
      cash += shares * fill;
      p.realized += shares * (fill - p.entry);
      p.shares -= shares;
      if (p.shares <= 0) {
        p.exitDate = date; p.exitReason = reason; p.pnl = p.realized; p.rMultiple = p.realized / p.initialRisk;
        trades.push(p);
      }
    }

    dates.forEach(function (date) {
      // 1. Daily management of positions opened on earlier days.
      positions.forEach(function (p) {
        var i = idx[p.symbol][date];
        if (i === undefined) return;
        var b = daily[p.symbol][i];
        if (b.open <= p.stop) closePart(p, p.shares, b.open, date, 'stop (gap)');
        else if (b.low <= p.stop) closePart(p, p.shares, p.stop, date, p.stop >= p.entry ? 'breakeven stop' : 'stop');
        else {
          p.daysHeld += 1;
          if (!p.partialDone && p.daysHeld >= o.partialDays && b.close > p.entry && o.partialFraction > 0) {
            var sell = Math.floor(p.shares * o.partialFraction);
            if (sell > 0) closePart(p, sell, b.close, date, 'partial');
            p.partialDone = true;
            p.stop = Math.max(p.stop, p.entry);
          }
          if (p.shares > 0) {
            var t = trail(p.symbol)[i];
            var trailing = p.partialDone || p.daysHeld >= o.partialDays;
            if (trailing && t !== null && b.close < t) closePart(p, p.shares, b.close, date, 'trail');
            else if (p.daysHeld >= o.maxHoldDays) closePart(p, p.shares, b.close, date, 'time');
          }
        }
        lastClose[p.symbol] = b.close;
      });
      positions = positions.filter(function (p) { return p.shares > 0; });

      // 2. Intraday entries, in the order they trigger.
      var equity = cash + mark();
      var entries = [];
      (candidates[date] || []).forEach(function (c) {
        counts.candidates++;
        if (positions.some(function (p) { return p.symbol === c.symbol; })) return;
        var bars = intraday[c.symbol] && intraday[c.symbol][date];
        if (!bars || !bars.length) { counts.noIntraday++; return; }
        var e = findEntry(bars, c, o);
        if (!e) { counts.noTrigger++; return; }
        if (e.skipped === 'wide') { counts.skippedWide++; return; }
        if (e.skipped === 'chase') { counts.skippedChase++; return; }
        entries.push({ c: c, e: e, bars: bars });
      });
      entries.sort(function (a, b) { return a.e.t - b.e.t || a.e.stopPct - b.e.stopPct; });
      entries.forEach(function (x) {
        var size = S.positionSize({ accountSize: equity, riskPct: o.riskPct, maxPositionPct: o.maxPositionPct, entry: x.e.entry, stop: x.e.stop });
        if (!size.valid) return;
        var room = equity * o.maxExposurePct / 100 - mark();
        var shares = Math.min(size.shares, Math.floor(Math.min(room, cash) / x.e.entry));
        if (shares <= 0) { counts.noRoom++; return; }
        counts.filled++;
        cash -= shares * x.e.entry;
        var p = {
          symbol: x.c.symbol, type: x.c.type, entryDate: date, entryMinute: x.e.t, entry: x.e.entry,
          stop: x.e.stop, initialStop: x.e.stop, shares: shares, initialShares: shares,
          initialRisk: shares * (x.e.entry - x.e.stop), daysHeld: 0, partialDone: false, realized: 0
        };
        positions.push(p);
        var hit = sameDayStop(x.bars, x.e.k, x.e.stop);
        if (hit !== null) { counts.stoppedSameDay++; closePart(p, p.shares, hit, date, 'stop (same day)'); }
        else {
          var i = idx[p.symbol][date];
          lastClose[p.symbol] = i !== undefined ? daily[p.symbol][i].close : x.bars[x.bars.length - 1].close;
        }
      });
      positions = positions.filter(function (p) { return p.shares > 0; });
      var ex = mark();
      curve.push({ date: date, equity: cash + ex, exposure: ex, open: positions.length });
    });

    positions.forEach(function (p) {
      var bars = daily[p.symbol];
      closePart(p, p.shares, bars[bars.length - 1].close, bars[bars.length - 1].date, 'end of test');
    });

    return { trades: trades, equityCurve: curve, counts: counts, stats: stats(trades, curve, o) };
  }

  function stats(trades, curve, o) {
    if (!curve.length) return null;
    var start = curve[0], end = curve[curve.length - 1];
    var years = Math.max(1 / 365, (Date.parse(end.date) - Date.parse(start.date)) / (365.25 * 864e5));
    var byType = {};
    trades.forEach(function (t) { (byType[t.type] = byType[t.type] || []).push(t); });
    var dd = BT.maxDrawdown(curve);
    return {
      start: start.date,
      end: end.date,
      totalReturnPct: (end.equity / o.initialEquity - 1) * 100,
      cagrPct: (Math.pow(end.equity / o.initialEquity, 1 / years) - 1) * 100,
      maxDrawdownPct: dd.dd,
      maxDrawdownPeriod: [dd.peak, dd.trough],
      avgExposurePct: curve.reduce(function (s, p) { return s + p.exposure / p.equity; }, 0) / curve.length * 100,
      medianStopPct: (function () {
        var a = trades.map(function (t) { return (t.entry - t.initialStop) / t.entry * 100; }).sort(function (x, y) { return x - y; });
        return a.length ? a[a.length >> 1] : 0;
      })(),
      all: BT.summarizeTrades(trades),
      byType: Object.keys(byType).reduce(function (acc, k) { acc[k] = BT.summarizeTrades(byType[k]); return acc; }, {})
    };
  }

  var api = { DEFAULTS: DEFAULTS, buildCandidates: buildCandidates, findEntry: findEntry, sameDayStop: sameDayStop, run: run };
  if (node) module.exports = api;
  else root.IntradayBacktest = api;
})(typeof window !== 'undefined' ? window : this);
