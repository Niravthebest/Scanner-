#!/usr/bin/env node
/*
 * Build backtest data from Massive (formerly Polygon.io) S3 flat files.
 *
 * Credentials come from the environment and are never written to disk:
 *   MASSIVE_ACCESS_KEY, MASSIVE_SECRET_KEY
 *   MASSIVE_ENDPOINT (default https://files.massive.com), MASSIVE_BUCKET (default flatfiles)
 *
 * Commands:
 *   node tools/massive.js daily --from=2021-01-01 --to=2026-09-28 --out=daily.json
 *        [--minPrice=5 --minDollarVolM=5 --minQualifyDays=20 --exclude=etfs.txt --cache=.massive-cache]
 *   node tools/massive.js intraday --candidates=candidates.json --out=intraday.json [--bar=5 --cache=...]
 *
 * Flat files are unadjusted. The daily command detects splits from overnight
 * gaps that match a split ratio almost exactly and back-adjusts earlier bars.
 * Downloads use curl (AWS SigV4) so they go through the environment's proxy.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const out = { _: [] };
  argv.forEach(a => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2]; else out._.push(a);
  });
  return out;
}

function s3Get(key, cacheDir) {
  const local = path.join(cacheDir, key);
  if (fs.existsSync(local)) return local;
  const id = process.env.MASSIVE_ACCESS_KEY;
  const secret = process.env.MASSIVE_SECRET_KEY;
  if (!id || !secret) throw new Error('Set MASSIVE_ACCESS_KEY and MASSIVE_SECRET_KEY');
  const endpoint = process.env.MASSIVE_ENDPOINT || 'https://files.massive.com';
  const bucket = process.env.MASSIVE_BUCKET || 'flatfiles';
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const tmp = local + '.part';
  let code;
  try {
    code = execFileSync('curl', [
      '-sS', '--max-time', '600', '-o', tmp, '-w', '%{http_code}',
      '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${id}:${secret}`,
      `${endpoint}/${bucket}/${key}`
    ]).toString().trim();
  } catch (e) {
    throw new Error(`download failed for ${key}: ${e.message.split('\n')[0]}`);
  }
  if (code === '404' || code === '403') { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } return null; }
  if (code !== '200') throw new Error(`HTTP ${code} for ${key}`);
  fs.renameSync(tmp, local);
  return local;
}

/** Parse a flat-file CSV (gzipped). Columns: ticker,volume,open,close,high,low,window_start,transactions */
function readCsvGz(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const lines = text.split('\n');
  const head = lines[0].split(',');
  const col = name => head.indexOf(name);
  const c = { ticker: col('ticker'), volume: col('volume'), open: col('open'), close: col('close'), high: col('high'), low: col('low'), ts: col('window_start') };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = lines[i].split(',');
    rows.push({
      ticker: f[c.ticker], volume: +f[c.volume], open: +f[c.open], close: +f[c.close], high: +f[c.high], low: +f[c.low],
      ts: f[c.ts] // nanoseconds since epoch, kept as string for precision
    });
  }
  return rows;
}

function weekdays(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const COMMON_STOCK = /^[A-Z]{1,5}(\.[A-Z])?$/; // drops warrants (…W, …WS), units, rights with suffixes, test symbols
const SPLIT_RATIOS = [2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 1.5, 1.25, 2.5];

/** Back-adjust earlier bars for splits detected as near-exact overnight ratio gaps. Returns split list. */
function adjustSplits(bars) {
  const splits = [];
  for (let i = bars.length - 1; i >= 1; i--) {
    const r = bars[i - 1].close / bars[i].open; // >1 forward split, <1 reverse split
    for (const k of SPLIT_RATIOS) {
      const fwd = Math.abs(r / k - 1) < 0.03;
      const rev = Math.abs(r * k - 1) < 0.03;
      if ((fwd || rev) && Math.abs(Math.log(r)) > Math.log(1.2)) {
        const factor = fwd ? k : 1 / k;
        for (let j = 0; j < i; j++) {
          const b = bars[j];
          b.open /= factor; b.high /= factor; b.low /= factor; b.close /= factor; b.volume *= factor;
        }
        splits.push({ date: bars[i].date, factor });
        break;
      }
    }
  }
  return splits;
}

function cmdDaily(args) {
  const cache = args.cache || '.massive-cache';
  const minPrice = +(args.minPrice || 5);
  const minDollarVol = +(args.minDollarVolM || 5) * 1e6;
  const minQualifyDays = +(args.minQualifyDays || 20);
  const exclude = new Set(args.exclude ? fs.readFileSync(args.exclude, 'utf8').split(/\s+/).filter(Boolean) : []);
  const keep = new Set((args.keep || 'SPY,QQQ,IWM,MDY').split(','));
  const days = weekdays(args.from, args.to);
  const series = {};
  const qualify = {};
  let got = 0;
  days.forEach((d, n) => {
    const [y, m] = d.split('-');
    const file = s3Get(`us_stocks_sip/day_aggs_v1/${y}/${m}/${d}.csv.gz`, cache);
    if (!file) return; // holiday
    got++;
    for (const r of readCsvGz(file)) {
      if (!COMMON_STOCK.test(r.ticker) || (exclude.has(r.ticker) && !keep.has(r.ticker))) continue;
      (series[r.ticker] = series[r.ticker] || []).push({ date: d, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume });
      if (r.close >= minPrice && r.close * r.volume >= minDollarVol) qualify[r.ticker] = (qualify[r.ticker] || 0) + 1;
    }
    if (n % 50 === 0) process.stderr.write(`daily ${d} (${got} files)\n`);
  });
  const out = {};
  let splitCount = 0;
  Object.keys(series).forEach(t => {
    if (!keep.has(t) && (qualify[t] || 0) < minQualifyDays) return;
    splitCount += adjustSplits(series[t]).length;
    out[t] = series[t];
  });
  fs.writeFileSync(args.out, JSON.stringify(out));
  console.log(`wrote ${Object.keys(out).length} tickers, ${got} trading days, ${splitCount} splits adjusted -> ${args.out}`);
}

/** Minutes after 09:30 New York time for a nanosecond UTC timestamp. */
function nyMinutes(tsNs) {
  const ms = Number(BigInt(tsNs) / 1000000n);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const h = +parts.find(p => p.type === 'hour').value % 24;
  const m = +parts.find(p => p.type === 'minute').value;
  return h * 60 + m - (9 * 60 + 30);
}

function cmdIntraday(args) {
  const cache = args.cache || '.massive-cache';
  const barMin = +(args.bar || 5);
  const cands = JSON.parse(fs.readFileSync(args.candidates, 'utf8'));
  const out = fs.existsSync(args.out) ? JSON.parse(fs.readFileSync(args.out, 'utf8')) : {};
  const dates = Object.keys(cands).sort();
  dates.forEach((d, n) => {
    const want = new Set(cands[d].map(c => c.symbol).filter(s => !(out[s] && out[s][d])));
    if (!want.size) return;
    const [y, m] = d.split('-');
    const file = s3Get(`us_stocks_sip/minute_aggs_v1/${y}/${m}/${d}.csv.gz`, cache);
    if (!file) return;
    const agg = {};
    for (const r of readCsvGz(file)) {
      if (!want.has(r.ticker)) continue;
      const t = nyMinutes(r.ts);
      if (t < 0 || t >= 390) continue; // regular session only
      const bucket = Math.floor(t / barMin) * barMin;
      const a = (agg[r.ticker] = agg[r.ticker] || {});
      const b = a[bucket];
      if (!b) a[bucket] = { t: bucket, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, _t: t };
      else {
        if (t < b._t) { b.open = r.open; b._t = t; }
        b.high = Math.max(b.high, r.high); b.low = Math.min(b.low, r.low); b.close = r.close; b.volume += r.volume;
      }
    }
    Object.keys(agg).forEach(s => {
      (out[s] = out[s] || {})[d] = Object.values(agg[s]).sort((a, b) => a.t - b.t).map(b => ({ t: b.t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
    });
    if (!args.keepCache) { try { fs.unlinkSync(file); } catch (e) { /* ignore */ } }
    if (n % 20 === 0) { process.stderr.write(`intraday ${d} (${n + 1}/${dates.length})\n`); fs.writeFileSync(args.out, JSON.stringify(out)); }
  });
  fs.writeFileSync(args.out, JSON.stringify(out));
  console.log(`wrote intraday bars for ${Object.keys(out).length} symbols -> ${args.out}`);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'daily') cmdDaily(args);
  else if (cmd === 'intraday') cmdIntraday(args);
  else { console.error('usage: node tools/massive.js daily|intraday [--options]'); process.exit(1); }
}

module.exports = { readCsvGz, adjustSplits, nyMinutes, weekdays, COMMON_STOCK };
