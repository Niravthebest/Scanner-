/*
 * Momentum swing scanner engine, modelled on the setups Martin Luk describes:
 *   - Episodic pivot / gap-up on heavy volume
 *   - First pullback to 9/21/50 EMA or anchored VWAP in a strong uptrend
 *   - Breakout from a tight base
 * plus stop-based position sizing (fixed % of account at risk per trade).
 *
 * Works on daily OHLCV bars: [{ date, open, high, low, close, volume }, ...]
 * sorted oldest -> newest. The last bar is treated as "today".
 * Pure functions only, usable from the browser (window.Scanner) or Node.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    // Liquidity / quality filters
    minPrice: 5,
    minAvgDollarVolM: 5, // 20-day average dollar volume, in $ millions
    minAdrPct: 3, // 20-day average daily range %
    // Episodic pivot / gap-up
    minGapPct: 4,
    minRvol: 2,
    // Pullback
    minPriorRunPct: 20, // size of the move before the pullback
    runLookback: 40,
    minPullbackPct: 3, // how far off the recent high price must be
    supportTolPct: 1.5, // how close the day's low must get to support
    // Breakout
    baseLength: 10,
    maxBaseRangePct: 15,
    breakoutMinRvol: 1.5,
    // Risk
    maxStopPct: 4, // Luk keeps stops roughly 1-4% wide
    accountSize: 25000,
    riskPct: 0.5, // % of account lost if the stop is hit
    maxPositionPct: 20, // cap on any single position, % of account
    maxExposurePct: 35 // cap on total open exposure, % of account
  };

  var MIN_BARS = 60;
  var AVWAP_LOOKBACK = 60;

  function withDefaults(opts) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = opts && opts[k];
      out[k] = typeof v === 'number' && isFinite(v) ? v : DEFAULTS[k];
    });
    return out;
  }

  /** EMA aligned to `values`; null until `period` values exist (seeded with the SMA). */
  function ema(values, period) {
    var out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    var k = 2 / (period + 1);
    var sum = 0;
    for (var i = 0; i < period; i++) sum += values[i];
    var prev = sum / period;
    out[period - 1] = prev;
    for (var j = period; j < values.length; j++) {
      prev = values[j] * k + prev * (1 - k);
      out[j] = prev;
    }
    return out;
  }

  function mean(arr) {
    if (!arr.length) return NaN;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  /** Average daily range % over the `period` bars ending at `end`. */
  function adrPct(bars, end, period) {
    period = period || 20;
    var start = Math.max(0, end - period + 1);
    var ranges = [];
    for (var i = start; i <= end; i++) {
      if (bars[i].low > 0) ranges.push((bars[i].high / bars[i].low - 1) * 100);
    }
    return mean(ranges);
  }

  /** Volume at `end` relative to the average of the `period` bars before it. */
  function relativeVolume(bars, end, period) {
    period = period || 20;
    var start = Math.max(0, end - period);
    var vols = [];
    for (var i = start; i < end; i++) vols.push(bars[i].volume);
    var avg = mean(vols);
    return avg > 0 ? bars[end].volume / avg : NaN;
  }

  function avgDollarVolume(bars, end, period) {
    period = period || 20;
    var start = Math.max(0, end - period + 1);
    var dv = [];
    for (var i = start; i <= end; i++) dv.push(bars[i].close * bars[i].volume);
    return mean(dv);
  }

  /** Index of the lowest low in the `lookback` bars ending at `end`. */
  function swingLowIndex(bars, end, lookback) {
    var start = Math.max(0, end - lookback + 1);
    var idx = start;
    for (var i = start + 1; i <= end; i++) {
      if (bars[i].low < bars[idx].low) idx = i;
    }
    return idx;
  }

  /** Volume-weighted average of typical price from bar `anchor` through `end`. */
  function anchoredVwap(bars, anchor, end) {
    var pv = 0;
    var vol = 0;
    for (var i = anchor; i <= end; i++) {
      var b = bars[i];
      var typical = (b.high + b.low + b.close) / 3;
      pv += typical * b.volume;
      vol += b.volume;
    }
    return vol > 0 ? pv / vol : NaN;
  }

  /**
   * Stop-based sizing: shares = (account * risk%) / (entry - stop),
   * then capped so a single position never exceeds maxPositionPct of the account.
   */
  function positionSize(p) {
    var accountSize = p.accountSize;
    var entry = p.entry;
    var stop = p.stop;
    var riskPerShare = entry - stop;
    if (!(accountSize > 0) || !(entry > 0) || !(riskPerShare > 0)) {
      return { valid: false, reason: 'Stop must be below entry' };
    }
    var riskBudget = accountSize * (p.riskPct / 100);
    var byRisk = Math.floor(riskBudget / riskPerShare);
    var maxPositionPct = p.maxPositionPct > 0 ? p.maxPositionPct : 100;
    var byCap = Math.floor((accountSize * maxPositionPct / 100) / entry);
    var shares = Math.max(0, Math.min(byRisk, byCap));
    return {
      valid: shares > 0,
      reason: shares > 0 ? '' : 'Account too small for one share at this risk',
      shares: shares,
      cappedBy: byCap < byRisk ? 'position cap' : 'risk',
      riskPerShare: riskPerShare,
      stopPct: (riskPerShare / entry) * 100,
      positionValue: shares * entry,
      positionPct: (shares * entry / accountSize) * 100,
      dollarRisk: shares * riskPerShare,
      riskPctActual: (shares * riskPerShare / accountSize) * 100
    };
  }

  function pctDiff(a, b) {
    return (a / b - 1) * 100;
  }

  function makeSetup(type, entry, stop, support, note, o) {
    var stopPct = ((entry - stop) / entry) * 100;
    return {
      type: type,
      entry: entry,
      stop: stop,
      support: support,
      stopPct: stopPct,
      wideStop: stopPct > o.maxStopPct,
      note: note,
      size: positionSize({
        accountSize: o.accountSize,
        riskPct: o.riskPct,
        maxPositionPct: o.maxPositionPct,
        entry: entry,
        stop: stop
      })
    };
  }

  function detectGapUp(bars, i, m, o) {
    var today = bars[i];
    if (m.gapPct < o.minGapPct || !(m.rvol >= o.minRvol)) return null;
    // Must hold the gap: close in the upper half of the day's range.
    var mid = (today.high + today.low) / 2;
    if (today.close < mid) return null;
    return makeSetup(
      'Gap-up / EP',
      today.close,
      today.low,
      null,
      'Gap +' + m.gapPct.toFixed(1) + '% on ' + m.rvol.toFixed(1) +
        'x volume. Live: use the opening-range low as the stop.',
      o
    );
  }

  function detectPullback(bars, i, m, o) {
    var today = bars[i];
    var inUptrend =
      today.close > m.ema50 && m.ema21 > m.ema50 && m.ema21 > m.ema21Prev5;
    if (!inUptrend) return null;

    // Size of the prior run: lowest low before the recent high -> that high.
    var start = Math.max(0, i - o.runLookback);
    var hiIdx = start;
    for (var j = start; j <= i; j++) if (bars[j].high > bars[hiIdx].high) hiIdx = j;
    var lo = Infinity;
    for (var k = start; k <= hiIdx; k++) lo = Math.min(lo, bars[k].low);
    var runPct = pctDiff(bars[hiIdx].high, lo);
    var offHighPct = -pctDiff(today.close, bars[hiIdx].high);
    if (runPct < o.minPriorRunPct || offHighPct < o.minPullbackPct) return null;

    // Highest support that the day's low tagged (or flushed through) and price reclaimed.
    var supports = [
      { name: '9 EMA', level: m.ema9 },
      { name: '21 EMA', level: m.ema21 },
      { name: '50 EMA', level: m.ema50 },
      { name: 'AVWAP', level: m.avwap }
    ]
      .filter(function (s) { return s.level > 0; })
      .sort(function (a, b) { return b.level - a.level; });

    for (var s = 0; s < supports.length; s++) {
      var lvl = supports[s].level;
      var tagged = today.low <= lvl * (1 + o.supportTolPct / 100);
      var held = today.close >= lvl;
      if (tagged && held) {
        var stop = Math.min(today.low, lvl);
        return makeSetup(
          'Pullback',
          today.close,
          stop,
          supports[s].name,
          'Up ' + runPct.toFixed(0) + '% then pulled back ' + offHighPct.toFixed(1) +
            '% to the ' + supports[s].name + ' and held.',
          o
        );
      }
    }
    return null;
  }

  function detectBreakout(bars, i, m, o) {
    var today = bars[i];
    if (i < o.baseLength + 1 || !(today.close > m.ema50)) return null;
    var baseHigh = -Infinity;
    var baseLow = Infinity;
    for (var j = i - o.baseLength; j < i; j++) {
      baseHigh = Math.max(baseHigh, bars[j].high);
      baseLow = Math.min(baseLow, bars[j].low);
    }
    var baseRangePct = pctDiff(baseHigh, baseLow);
    if (baseRangePct > o.maxBaseRangePct) return null;
    if (!(today.close > baseHigh) || !(m.rvol >= o.breakoutMinRvol)) return null;
    return makeSetup(
      'Breakout',
      today.close,
      today.low,
      null,
      'Cleared a ' + o.baseLength + '-day base (' + baseRangePct.toFixed(1) +
        '% range) on ' + m.rvol.toFixed(1) + 'x volume.',
      o
    );
  }

  /** Compute metrics and setups for one symbol. Returns null if not enough data. */
  function analyze(symbol, bars, opts) {
    var o = withDefaults(opts);
    if (!bars || bars.length < MIN_BARS) return null;
    var i = bars.length - 1;
    var closes = bars.map(function (b) { return b.close; });
    var e9 = ema(closes, 9);
    var e21 = ema(closes, 21);
    var e50 = ema(closes, 50);
    var today = bars[i];
    var anchor = swingLowIndex(bars, i, AVWAP_LOOKBACK);

    var m = {
      price: today.close,
      changePct: pctDiff(today.close, bars[i - 1].close),
      gapPct: pctDiff(today.open, bars[i - 1].close),
      rvol: relativeVolume(bars, i, 20),
      adrPct: adrPct(bars, i, 20),
      avgDollarVol: avgDollarVolume(bars, i, 20),
      ema9: e9[i],
      ema21: e21[i],
      ema21Prev5: e21[i - 5],
      ema50: e50[i],
      avwap: anchoredVwap(bars, anchor, i),
      avwapAnchorDate: bars[anchor].date
    };
    m.vsEma9 = pctDiff(today.close, m.ema9);
    m.vsEma21 = pctDiff(today.close, m.ema21);
    m.vsEma50 = pctDiff(today.close, m.ema50);

    var failed = [];
    if (m.price < o.minPrice) failed.push('price');
    if (m.avgDollarVol < o.minAvgDollarVolM * 1e6) failed.push('liquidity');
    if (!(m.adrPct >= o.minAdrPct)) failed.push('ADR');

    var setups = [];
    if (!failed.length) {
      [detectGapUp, detectPullback, detectBreakout].forEach(function (fn) {
        var s = fn(bars, i, m, o);
        if (s) setups.push(s);
      });
      // Prefer the setup with the tightest stop.
      setups.sort(function (a, b) { return a.stopPct - b.stopPct; });
    }

    return {
      symbol: symbol,
      date: today.date,
      metrics: m,
      failedFilters: failed,
      setups: setups,
      best: setups[0] || null
    };
  }

  /**
   * Scan many symbols. `dataset` is { SYMBOL: bars[] }.
   * Returns analysed symbols; those with setups first (tightest valid stop, then RVOL).
   */
  function scan(dataset, opts) {
    var results = [];
    var skipped = [];
    Object.keys(dataset).forEach(function (sym) {
      var r = analyze(sym, dataset[sym], opts);
      if (r) results.push(r);
      else skipped.push(sym);
    });
    results.sort(function (a, b) {
      if (!!a.best !== !!b.best) return a.best ? -1 : 1;
      if (a.best && b.best && a.best.wideStop !== b.best.wideStop) {
        return a.best.wideStop ? 1 : -1;
      }
      return (b.metrics.rvol || 0) - (a.metrics.rvol || 0);
    });
    return { results: results, skipped: skipped };
  }

  /** Total exposure and risk of a planned set of positions vs the exposure cap. */
  function planSummary(positions, opts) {
    var o = withDefaults(opts);
    var value = 0;
    var risk = 0;
    positions.forEach(function (p) {
      value += p.positionValue || 0;
      risk += p.dollarRisk || 0;
    });
    var exposurePct = (value / o.accountSize) * 100;
    return {
      count: positions.length,
      value: value,
      exposurePct: exposurePct,
      dollarRisk: risk,
      riskPct: (risk / o.accountSize) * 100,
      overCap: exposurePct > o.maxExposurePct
    };
  }

  var api = {
    DEFAULTS: DEFAULTS,
    MIN_BARS: MIN_BARS,
    withDefaults: withDefaults,
    ema: ema,
    adrPct: adrPct,
    relativeVolume: relativeVolume,
    avgDollarVolume: avgDollarVolume,
    swingLowIndex: swingLowIndex,
    anchoredVwap: anchoredVwap,
    positionSize: positionSize,
    analyze: analyze,
    scan: scan,
    planSummary: planSummary
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scanner = api;
})(typeof window !== 'undefined' ? window : this);
