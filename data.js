/*
 * Data sources for the scanner. Each returns a dataset: { SYMBOL: bars[] }
 * with bars sorted oldest -> newest: { date, open, high, low, close, volume }.
 *
 *   - demoDataset(): synthetic, fictional tickers engineered to show each setup
 *   - parseCsv(text): symbol,date,open,high,low,close,volume
 *   - fetchPolygon(symbols, apiKey, opts): daily bars from the Polygon.io REST API
 */
(function (root) {
  'use strict';

  // ---------- helpers ----------

  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  /** The last `n` weekdays ending at `end` (inclusive if it is a weekday). */
  function tradingDays(n, end) {
    var out = [];
    var d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    while (out.length < n) {
      var dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) out.push(isoDate(d));
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return out.reverse();
  }

  function validBar(b) {
    return ['open', 'high', 'low', 'close', 'volume'].every(function (k) {
      return typeof b[k] === 'number' && isFinite(b[k]);
    }) && b.high >= b.low && b.low > 0;
  }

  // ---------- demo data ----------

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeGen(seed) {
    var rand = mulberry32(seed);
    function normal() {
      var u = 1 - rand();
      var v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    // Append `n` random bars with the given daily drift and volatility.
    function walk(bars, n, drift, vol, baseVol, start) {
      var prev = bars.length ? bars[bars.length - 1].close : start;
      for (var i = 0; i < n; i++) {
        var open = prev * (1 + normal() * vol * 0.25);
        var close = open * (1 + drift + normal() * vol * 0.6);
        var high = Math.max(open, close) * (1 + Math.abs(normal()) * vol * 0.5 + vol * 0.3);
        var low = Math.min(open, close) * (1 - Math.abs(normal()) * vol * 0.5 - vol * 0.3);
        var volume = Math.round(baseVol * Math.max(0.3, 1 + normal() * 0.3));
        bars.push({ open: open, high: high, low: low, close: close, volume: volume });
        prev = close;
      }
      return bars;
    }
    return { walk: walk, normal: normal };
  }

  function lastEma(bars, period) {
    var k = 2 / (period + 1);
    var e = 0;
    for (var i = 0; i < period; i++) e += bars[i].close;
    e /= period;
    for (var j = period; j < bars.length; j++) e = bars[j].close * k + e * (1 - k);
    return e;
  }

  function withDates(bars, end) {
    var dates = tradingDays(bars.length, end);
    return bars.map(function (b, i) {
      return {
        date: dates[i],
        open: +b.open.toFixed(2),
        high: +b.high.toFixed(2),
        low: +b.low.toFixed(2),
        close: +b.close.toFixed(2),
        volume: b.volume
      };
    });
  }

  /** Fictional tickers, each built to demonstrate one outcome. Deterministic per seed. */
  function demoDataset(seed, endDate) {
    var g = makeGen(seed || 42);
    var end = endDate || new Date();
    var ds = {};
    var prev;

    // Gap-up on heavy volume, holding near the highs, tight low-of-day stop.
    var gap = g.walk([], 100, 0.002, 0.035, 2e6, 40);
    prev = gap[gap.length - 1].close;
    var o = prev * 1.08;
    gap.push({ open: o, low: o * 0.995, high: o * 1.04, close: o * 1.03, volume: 8e6 });
    ds.XGAP = gap;

    // Same gap, but a wide intraday range -> stop too wide to take.
    var wide = g.walk([], 100, 0.002, 0.035, 2e6, 25);
    prev = wide[wide.length - 1].close;
    o = prev * 1.07;
    wide.push({ open: o, low: o * 0.95, high: o * 1.07, close: o * 1.05, volume: 7e6 });
    ds.XWIDE = wide;

    // Strong run, orderly pullback, then a flush into the 21 EMA that holds.
    var pb = g.walk([], 60, 0.0, 0.03, 3e6, 30);
    g.walk(pb, 30, 0.015, 0.03, 4e6);
    g.walk(pb, 4, -0.008, 0.02, 2.5e6);
    var e21 = lastEma(pb, 21);
    prev = pb[pb.length - 1].close;
    var pbClose = e21 * 1.006;
    pb.push({
      open: Math.max(prev * 0.995, e21 * 1.004),
      low: e21 * 0.99,
      high: pbClose * 1.012,
      close: pbClose,
      volume: 2.2e6
    });
    ds.XPULL = pb;

    // Uptrend, tight 12-day base, breakout on volume.
    var bo = g.walk([], 75, 0.004, 0.03, 1.5e6, 45);
    var basePrice = bo[bo.length - 1].close;
    for (var i = 0; i < 12; i++) {
      var c = basePrice * (1 + g.normal() * 0.008);
      bo.push({ open: c * (1 + g.normal() * 0.004), high: c * 1.018, low: c * 0.985, close: c, volume: 1.1e6 });
    }
    var baseHigh = Math.max.apply(null, bo.slice(-12).map(function (b) { return b.high; }));
    o = baseHigh * 0.995;
    bo.push({ open: o, low: o * 0.998, high: baseHigh * 1.035, close: baseHigh * 1.03, volume: 3.8e6 });
    ds.XBASE = bo;

    // Noise and filter failures.
    ds.XDOWN = g.walk([], 100, -0.006, 0.03, 3e6, 80); // downtrend
    ds.XFLAT = g.walk([], 100, 0.0, 0.008, 5e6, 120); // too quiet (low ADR)
    ds.XPENNY = g.walk([], 100, 0.001, 0.06, 2e7, 2); // under the price filter
    ds.XTHIN = g.walk([], 100, 0.002, 0.04, 2e4, 30); // illiquid
    ds.XCHOP = g.walk([], 100, 0.0, 0.035, 2e6, 55); // sideways chop

    Object.keys(ds).forEach(function (sym) { ds[sym] = withDates(ds[sym], end); });
    return ds;
  }

  // ---------- CSV ----------

  var COLUMN_ALIASES = {
    symbol: ['symbol', 'ticker'],
    date: ['date', 'time', 'timestamp'],
    open: ['open', 'o'],
    high: ['high', 'h'],
    low: ['low', 'l'],
    close: ['close', 'c', 'adj close', 'adj_close'],
    volume: ['volume', 'vol', 'v']
  };

  /**
   * Parse long-format CSV: one row per symbol per day.
   * Returns { dataset, errors } where errors lists skipped rows.
   */
  function parseCsv(text, defaultSymbol) {
    var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return { dataset: {}, errors: ['File is empty'] };
    var header = lines[0].split(',').map(function (h) {
      return h.trim().replace(/^"|"$/g, '').toLowerCase();
    });
    var idx = {};
    Object.keys(COLUMN_ALIASES).forEach(function (key) {
      idx[key] = header.findIndex(function (h) { return COLUMN_ALIASES[key].indexOf(h) !== -1; });
    });
    var missing = ['date', 'open', 'high', 'low', 'close', 'volume'].filter(function (k) { return idx[k] < 0; });
    if (idx.symbol < 0 && !defaultSymbol) missing.unshift('symbol');
    if (missing.length) {
      return { dataset: {}, errors: ['Missing column(s): ' + missing.join(', ')] };
    }

    var dataset = {};
    var errors = [];
    for (var r = 1; r < lines.length; r++) {
      var cells = lines[r].split(',').map(function (c) { return c.trim().replace(/^"|"$/g, ''); });
      var sym = (idx.symbol >= 0 ? cells[idx.symbol] : defaultSymbol || '').toUpperCase();
      var bar = {
        date: cells[idx.date],
        open: parseFloat(cells[idx.open]),
        high: parseFloat(cells[idx.high]),
        low: parseFloat(cells[idx.low]),
        close: parseFloat(cells[idx.close]),
        volume: parseFloat(cells[idx.volume])
      };
      if (!sym || !bar.date || !validBar(bar)) {
        if (errors.length < 20) errors.push('Row ' + (r + 1) + ' skipped');
        continue;
      }
      (dataset[sym] = dataset[sym] || []).push(bar);
    }
    Object.keys(dataset).forEach(function (sym) {
      dataset[sym].sort(function (a, b) {
        var ta = Date.parse(a.date);
        var tb = Date.parse(b.date);
        return isNaN(ta) || isNaN(tb) ? (a.date < b.date ? -1 : 1) : ta - tb;
      });
    });
    return { dataset: dataset, errors: errors };
  }

  // ---------- Polygon.io ----------

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(new Error('Cancelled'));
      var t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', function () {
          clearTimeout(t);
          reject(new Error('Cancelled'));
        }, { once: true });
      }
    });
  }

  /**
   * Fetch ~`calendarDays` of daily bars per symbol, one request per symbol.
   * The free Polygon tier allows 5 requests/minute, hence the default 12.5s delay.
   */
  async function fetchPolygon(symbols, apiKey, opts) {
    opts = opts || {};
    var delayMs = opts.delayMs != null ? opts.delayMs : 12500;
    var calendarDays = opts.calendarDays || 300;
    var fetchFn = opts.fetch || root.fetch.bind(root);
    var to = new Date();
    var from = new Date(to.getTime() - calendarDays * 864e5);
    var dataset = {};
    var errors = [];

    for (var n = 0; n < symbols.length; n++) {
      var sym = symbols[n];
      if (opts.onProgress) opts.onProgress(n, symbols.length, sym);
      var url = 'https://api.polygon.io/v2/aggs/ticker/' + encodeURIComponent(sym) +
        '/range/1/day/' + isoDate(from) + '/' + isoDate(to) +
        '?adjusted=true&sort=asc&limit=50000&apiKey=' + encodeURIComponent(apiKey);
      try {
        var res = await fetchFn(url, { signal: opts.signal });
        if (res.status === 429) {
          // Rate limited: wait out the minute and retry once.
          await sleep(60000, opts.signal);
          res = await fetchFn(url, { signal: opts.signal });
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        var bars = (json.results || []).map(function (r) {
          return { date: isoDate(new Date(r.t)), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v };
        }).filter(validBar);
        if (bars.length) dataset[sym] = bars;
        else errors.push(sym + ': no data');
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw new Error('Cancelled');
        errors.push(sym + ': ' + e.message);
      }
      if (n < symbols.length - 1 && delayMs > 0) await sleep(delayMs, opts.signal);
    }
    if (opts.onProgress) opts.onProgress(symbols.length, symbols.length, '');
    return { dataset: dataset, errors: errors };
  }

  function parseSymbols(text) {
    var seen = {};
    return String(text)
      .toUpperCase()
      .split(/[\s,;]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) {
        if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) || seen[s]) return false;
        seen[s] = true;
        return true;
      });
  }

  var api = {
    demoDataset: demoDataset,
    parseCsv: parseCsv,
    fetchPolygon: fetchPolygon,
    parseSymbols: parseSymbols,
    tradingDays: tradingDays
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScannerData = api;
})(typeof window !== 'undefined' ? window : globalThis);
