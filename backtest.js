/*
 * Portfolio backtest for the momentum scanner.
 *
 * Day loop over a shared calendar:
 *   1. Manage open positions on today's bar: stop hits (gap-downs fill at the
 *      open), partial profit after N days with stop to breakeven, and a trailing
 *      exit on a close below the EMA.
 *   2. Fill yesterday's signals: buy-stop above the signal day's high
 *      (or at the signal day's close in 'close' mode). If a bar trades through
 *      both entry and stop, the stop is assumed to be hit (worst case).
 *   3. Scan today's close for new signals (only data up to today is used).
 *
 * Sizing is stop-based: shares = equity * riskPct / (entry - stop), capped by
 * maxPositionPct of equity and by the total exposure cap.
 */
(function (root) {
  'use strict';

  var S = typeof module !== 'undefined' && module.exports ? require('./scanner.js') : root.Scanner;

  var BT_DEFAULTS = {
    startDate: null, // first date signals may be taken (warm-up data before it is still used)
    endDate: null,
    initialEquity: 100000,
    entryMode: 'breakout', // 'breakout' = buy-stop above signal high next day, 'close' = buy signal close
    maxChasePct: 3, // skip a breakout fill that opens this far above the trigger
    partialDays: 3,
    partialFraction: 1 / 3,
    trailEma: 10,
    maxHoldDays: 60,
    slippagePct: 0.05,
    skipWideStops: true,
    setupTypes: null, // e.g. ['Pullback'] to restrict; null = all
    marketFilter: null, // { symbol: 'QQQ', ema: 21 } -> only enter when index closes above its EMA
    lookbackBars: 200, // bars handed to the scanner each day (EMA50 is well converged by then)
    partialAtR: null, // if set, take the partial when the close reaches entry + N x initial risk (instead of after partialDays)
    trailAfterDays: null, // days before the trailing exit applies; null = partialDays
    strategy: null // optional { prepare(prepared, calendar, symbols, o) -> ctx, signal(sym, P, i, ctx, o) -> {type, trigger, stop, stopPct, rank} }
  };

  function withBtDefaults(opts) {
    var out = S.withDefaults(opts);
    Object.keys(BT_DEFAULTS).forEach(function (k) {
      out[k] = opts && opts[k] !== undefined ? opts[k] : BT_DEFAULTS[k];
    });
    return out;
  }

  function slip(price, pct, dir) {
    return price * (1 + dir * pct / 100);
  }

  /** Build per-symbol lookups: date -> bar index, and the trailing EMA series. */
  function prepare(dataset, o) {
    var prepared = {};
    var dateSet = {};
    Object.keys(dataset).forEach(function (sym) {
      var bars = dataset[sym];
      if (!bars || !bars.length) return;
      var idx = {};
      bars.forEach(function (b, i) { idx[b.date] = i; dateSet[b.date] = true; });
      prepared[sym] = {
        bars: bars,
        idx: idx,
        trail: S.ema(bars.map(function (b) { return b.close; }), o.trailEma)
      };
    });
    var calendar = Object.keys(dateSet).sort();
    return { prepared: prepared, calendar: calendar };
  }

  function marketOk(prep, o, date) {
    if (!o.marketFilter) return true;
    var m = prep[o.marketFilter.symbol];
    if (!m) return true;
    if (!m.filterEma) m.filterEma = S.ema(m.bars.map(function (b) { return b.close; }), o.marketFilter.ema || 21);
    var i = m.idx[date];
    if (i === undefined || m.filterEma[i] === null) return false;
    return m.bars[i].close > m.filterEma[i];
  }

  function run(dataset, opts, tradeUniverse) {
    var o = withBtDefaults(opts);
    var p = prepare(dataset, o);
    var prep = p.prepared;
    var calendar = p.calendar.filter(function (d) { return !o.endDate || d <= o.endDate; });
    var symbols = (tradeUniverse || Object.keys(prep)).filter(function (s) { return prep[s]; });
    var ctx = o.strategy && o.strategy.prepare ? o.strategy.prepare(prep, calendar, symbols, o) : null;

    var cash = o.initialEquity;
    var positions = []; // open
    var trades = []; // closed
    var pending = []; // signals waiting for next-day fill
    var equityCurve = [];
    var lastClose = {};

    function equityAt() {
      var v = cash;
      positions.forEach(function (pos) { v += pos.shares * (lastClose[pos.symbol] || pos.entry); });
      return v;
    }

    function exposure() {
      var v = 0;
      positions.forEach(function (pos) { v += pos.shares * (lastClose[pos.symbol] || pos.entry); });
      return v;
    }

    function closePart(pos, shares, price, date, reason) {
      var fill = slip(price, o.slippagePct, -1);
      cash += shares * fill;
      pos.realized += shares * (fill - pos.entry);
      pos.shares -= shares;
      if (pos.shares <= 0) {
        pos.exitDate = date;
        pos.exitReason = reason;
        pos.pnl = pos.realized;
        pos.rMultiple = pos.realized / pos.initialRisk;
        trades.push(pos);
      }
    }

    calendar.forEach(function (date) {
      var active = !o.startDate || date >= o.startDate;

      // Update marks first so equity-based sizing uses today's open-ish values.
      // 1. Manage open positions.
      positions.slice().forEach(function (pos) {
        var P = prep[pos.symbol];
        var i = P.idx[date];
        if (i === undefined) return;
        var b = P.bars[i];
        if (b.open <= pos.stop) {
          closePart(pos, pos.shares, b.open, date, 'stop (gap)');
        } else if (b.low <= pos.stop) {
          closePart(pos, pos.shares, pos.stop, date, pos.stop >= pos.entry ? 'breakeven stop' : 'stop');
        } else {
          pos.daysHeld += 1;
          var partialDue = o.partialAtR
            ? b.close >= pos.entry + o.partialAtR * (pos.entry - pos.initialStop)
            : pos.daysHeld >= o.partialDays && b.close > pos.entry;
          if (!pos.partialDone && partialDue && o.partialFraction > 0) {
            var sell = Math.floor(pos.shares * o.partialFraction);
            if (sell > 0) closePart(pos, sell, b.close, date, 'partial');
            pos.partialDone = true;
            pos.stop = Math.max(pos.stop, pos.entry);
          }
          if (pos.shares > 0) {
            var t = P.trail[i];
            // Trail only once the partial window has passed; before that only the initial stop applies.
            var trailing = pos.partialDone || pos.daysHeld >= (o.trailAfterDays !== null ? o.trailAfterDays : o.partialDays);
            if (trailing && t !== null && b.close < t) closePart(pos, pos.shares, b.close, date, 'trail');
            else if (pos.daysHeld >= o.maxHoldDays) closePart(pos, pos.shares, b.close, date, 'time');
          }
        }
        lastClose[pos.symbol] = b.close;
      });
      positions = positions.filter(function (pos) { return pos.shares > 0; });

      // 2. Fill yesterday's signals, best first.
      var equity = equityAt();
      pending.forEach(function (sig) {
        if (positions.some(function (pos) { return pos.symbol === sig.symbol; })) return;
        var P = prep[sig.symbol];
        var i = P.idx[date];
        if (i === undefined) return;
        var b = P.bars[i];
        var fillRaw;
        if (o.entryMode === 'close') {
          fillRaw = null; // filled at signal close below
        } else {
          if (b.high < sig.trigger) return; // never triggered
          if (b.open > sig.trigger * (1 + o.maxChasePct / 100)) return; // gapped too far to chase
          fillRaw = Math.max(b.open, sig.trigger);
        }
        if (fillRaw === null) return;
        var entry = slip(fillRaw, o.slippagePct, 1);
        var stop = sig.stop;
        if (!(entry > stop)) return;
        var size = S.positionSize({
          accountSize: equity, riskPct: o.riskPct, maxPositionPct: o.maxPositionPct, entry: entry, stop: stop
        });
        if (!size.valid) return;
        var room = equity * o.maxExposurePct / 100 - exposure();
        var shares = Math.min(size.shares, Math.floor(Math.min(room, cash) / entry));
        if (shares <= 0) return;
        cash -= shares * entry;
        var pos = {
          symbol: sig.symbol, type: sig.type, signalDate: sig.date, entryDate: date,
          entry: entry, stop: stop, initialStop: stop, shares: shares, initialShares: shares,
          initialRisk: shares * (entry - stop), daysHeld: 0, partialDone: false, realized: 0
        };
        positions.push(pos);
        lastClose[sig.symbol] = b.close;
        // Worst case: if today's range also reached the stop, assume it was hit.
        if (b.low <= stop) closePart(pos, pos.shares, Math.min(stop, b.open < stop ? b.open : stop), date, 'stop (same day)');
      });
      positions = positions.filter(function (pos) { return pos.shares > 0; });
      pending = [];

      // 3. Scan today's close for tomorrow.
      if (active && marketOk(prep, o, date)) {
        var sigs = [];
        symbols.forEach(function (sym) {
          var P = prep[sym];
          var i = P.idx[date];
          if (i === undefined || i < S.MIN_BARS) return;
          if (o.strategy) {
            var sg = o.strategy.signal(sym, P, i, ctx, o);
            if (sg) sigs.push(Object.assign({ symbol: sym, date: date }, sg, o.entryMode === 'close' ? { trigger: P.bars[i].close, atClose: true } : {}));
            return;
          }
          var window = P.bars.slice(Math.max(0, i + 1 - o.lookbackBars), i + 1);
          var r = S.analyze(sym, window, o);
          if (!r || !r.setups.length) return;
          var setups = r.setups.filter(function (s) {
            return (!o.skipWideStops || !s.wideStop) && (!o.setupTypes || o.setupTypes.indexOf(s.type) !== -1);
          });
          if (!setups.length) return;
          var s = setups[0];
          var bar = P.bars[i];
          if (o.entryMode === 'close') {
            // Buy at today's close (e.g. into a reclaim near the close).
            sigs.push({ symbol: sym, date: date, type: s.type, trigger: bar.close, stop: s.stop, stopPct: s.stopPct, rvol: r.metrics.rvol, atClose: true });
          } else {
            sigs.push({ symbol: sym, date: date, type: s.type, trigger: bar.high, stop: s.stop, stopPct: s.stopPct, rvol: r.metrics.rvol });
          }
        });
        sigs.sort(function (a, b) {
          if (a.rank !== undefined || b.rank !== undefined) return (b.rank || 0) - (a.rank || 0);
          return a.stopPct - b.stopPct || (b.rvol || 0) - (a.rvol || 0);
        });

        if (o.entryMode === 'close') {
          // Fill immediately at the close.
          var eq = equityAt();
          sigs.forEach(function (sig) {
            if (positions.some(function (pos) { return pos.symbol === sig.symbol; })) return;
            var entry = slip(sig.trigger, o.slippagePct, 1);
            if (!(entry > sig.stop)) return;
            var size = S.positionSize({ accountSize: eq, riskPct: o.riskPct, maxPositionPct: o.maxPositionPct, entry: entry, stop: sig.stop });
            if (!size.valid) return;
            var room = eq * o.maxExposurePct / 100 - exposure();
            var shares = Math.min(size.shares, Math.floor(Math.min(room, cash) / entry));
            if (shares <= 0) return;
            cash -= shares * entry;
            positions.push({
              symbol: sig.symbol, type: sig.type, signalDate: date, entryDate: date,
              entry: entry, stop: sig.stop, initialStop: sig.stop, shares: shares, initialShares: shares,
              initialRisk: shares * (entry - sig.stop), daysHeld: 0, partialDone: false, realized: 0
            });
            lastClose[sig.symbol] = sig.trigger;
          });
        } else {
          pending = sigs;
        }
      }

      if (active) equityCurve.push({ date: date, equity: equityAt(), exposure: exposure(), open: positions.length });
    });

    // Close anything still open at the last available close.
    positions.forEach(function (pos) {
      var P = prep[pos.symbol];
      var last = P.bars[P.bars.length - 1];
      closePart(pos, pos.shares, last.close, last.date, 'end of test');
    });

    return { trades: trades, equityCurve: equityCurve, stats: stats(trades, equityCurve, o) };
  }

  function maxDrawdown(curve) {
    var peak = -Infinity;
    var dd = 0;
    var peakDate = null;
    var worst = { dd: 0, peak: null, trough: null };
    curve.forEach(function (p) {
      if (p.equity > peak) { peak = p.equity; peakDate = p.date; }
      dd = (p.equity / peak - 1) * 100;
      if (dd < worst.dd) worst = { dd: dd, peak: peakDate, trough: p.date };
    });
    return worst;
  }

  function summarizeTrades(list) {
    var wins = list.filter(function (t) { return t.pnl > 0; });
    var losses = list.filter(function (t) { return t.pnl <= 0; });
    var sum = function (a, f) { return a.reduce(function (s, t) { return s + f(t); }, 0); };
    var grossWin = sum(wins, function (t) { return t.pnl; });
    var grossLoss = -sum(losses, function (t) { return t.pnl; });
    var rs = list.map(function (t) { return t.rMultiple; }).sort(function (a, b) { return b - a; });
    return {
      trades: list.length,
      winRate: list.length ? (wins.length / list.length) * 100 : 0,
      avgWinR: wins.length ? sum(wins, function (t) { return t.rMultiple; }) / wins.length : 0,
      avgLossR: losses.length ? sum(losses, function (t) { return t.rMultiple; }) / losses.length : 0,
      expectancyR: list.length ? sum(list, function (t) { return t.rMultiple; }) / list.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
      bestR: rs.length ? rs[0] : 0,
      top5PctOfProfit: grossWin > 0
        ? (list.slice().sort(function (a, b) { return b.pnl - a.pnl; }).slice(0, 5)
          .reduce(function (s, t) { return s + Math.max(0, t.pnl); }, 0) / (grossWin - grossLoss)) * 100
        : 0,
      pnl: grossWin - grossLoss
    };
  }

  function stats(trades, curve, o) {
    if (!curve.length) return null;
    var start = curve[0];
    var end = curve[curve.length - 1];
    var years = (Date.parse(end.date) - Date.parse(start.date)) / (365.25 * 864e5);
    var total = (end.equity / o.initialEquity - 1) * 100;
    var byType = {};
    trades.forEach(function (t) { (byType[t.type] = byType[t.type] || []).push(t); });
    var byYear = {};
    curve.forEach(function (p) {
      var y = p.date.slice(0, 4);
      if (!byYear[y]) byYear[y] = { first: p.equity, last: p.equity };
      byYear[y].last = p.equity;
    });
    var prevEnd = o.initialEquity;
    var yearly = {};
    Object.keys(byYear).sort().forEach(function (y) {
      yearly[y] = (byYear[y].last / prevEnd - 1) * 100;
      prevEnd = byYear[y].last;
    });
    var dd = maxDrawdown(curve);
    var avgExposure = curve.reduce(function (s, p) { return s + p.exposure / p.equity; }, 0) / curve.length * 100;
    var holds = trades.map(function (t) {
      return (Date.parse(t.exitDate) - Date.parse(t.entryDate)) / 864e5;
    });
    return {
      start: start.date,
      end: end.date,
      totalReturnPct: total,
      cagrPct: years > 0 ? (Math.pow(end.equity / o.initialEquity, 1 / years) - 1) * 100 : 0,
      maxDrawdownPct: dd.dd,
      maxDrawdownPeriod: [dd.peak, dd.trough],
      avgExposurePct: avgExposure,
      avgHoldCalendarDays: holds.length ? holds.reduce(function (a, b) { return a + b; }, 0) / holds.length : 0,
      yearly: yearly,
      all: summarizeTrades(trades),
      byType: Object.keys(byType).reduce(function (acc, k) { acc[k] = summarizeTrades(byType[k]); return acc; }, {})
    };
  }

  /** Buy-and-hold return of one symbol over the same dates, for comparison. */
  function benchmark(bars, startDate, endDate) {
    var inRange = bars.filter(function (b) { return b.date >= startDate && b.date <= endDate; });
    if (inRange.length < 2) return null;
    var curve = inRange.map(function (b) { return { date: b.date, equity: b.close }; });
    var years = (Date.parse(inRange[inRange.length - 1].date) - Date.parse(inRange[0].date)) / (365.25 * 864e5);
    var ratio = inRange[inRange.length - 1].close / inRange[0].close;
    return {
      totalReturnPct: (ratio - 1) * 100,
      cagrPct: (Math.pow(ratio, 1 / years) - 1) * 100,
      maxDrawdownPct: maxDrawdown(curve).dd
    };
  }

  var api = { BT_DEFAULTS: BT_DEFAULTS, run: run, benchmark: benchmark, maxDrawdown: maxDrawdown, summarizeTrades: summarizeTrades };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Backtest = api;
})(typeof window !== 'undefined' ? window : this);
