'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const M = require('../tools/massive.js');

test('readCsvGz parses flat-file rows', () => {
  const csv = 'ticker,volume,open,close,high,low,window_start,transactions\nAAPL,100,10,11,12,9,1700000000000000000,5\n';
  const f = path.join(os.tmpdir(), 'massive-test.csv.gz');
  fs.writeFileSync(f, zlib.gzipSync(csv));
  const rows = M.readCsvGz(f);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].ticker, rows[0].open, rows[0].high, rows[0].low, rows[0].close, rows[0].volume], ['AAPL', 10, 12, 9, 11, 100]);
  fs.unlinkSync(f);
});

test('adjustSplits back-adjusts a 2-for-1 split and leaves normal moves alone', () => {
  const bars = [
    { date: 'd1', open: 200, high: 205, low: 195, close: 200, volume: 100 },
    { date: 'd2', open: 200, high: 210, low: 198, close: 204, volume: 100 },
    { date: 'd3', open: 102, high: 104, low: 100, close: 103, volume: 200 }, // split
    { date: 'd4', open: 103, high: 115, low: 102, close: 112, volume: 300 } // normal day
  ];
  const splits = M.adjustSplits(bars);
  assert.deepEqual(splits, [{ date: 'd3', factor: 2 }]);
  assert.equal(bars[0].close, 100);
  assert.equal(bars[1].close, 102);
  assert.equal(bars[0].volume, 200);
  assert.equal(bars[3].close, 112);
});

test('adjustSplits handles a 1-for-10 reverse split', () => {
  const bars = [
    { date: 'd1', open: 1, high: 1.1, low: 0.9, close: 1, volume: 1e6 },
    { date: 'd2', open: 10, high: 10.5, low: 9.8, close: 10.2, volume: 1e5 }
  ];
  M.adjustSplits(bars);
  assert.ok(Math.abs(bars[0].close - 10) < 1e-9);
});

test('nyMinutes converts to minutes after the 09:30 ET open across DST', () => {
  const ns = ms => (BigInt(ms) * 1000000n).toString();
  assert.equal(M.nyMinutes(ns(Date.UTC(2026, 6, 1, 13, 30))), 0); // EDT: 13:30 UTC = 09:30
  assert.equal(M.nyMinutes(ns(Date.UTC(2026, 0, 5, 14, 35))), 5); // EST: 14:35 UTC = 09:35
});

test('common-stock filter drops warrants and units', () => {
  assert.ok(M.COMMON_STOCK.test('AAPL'));
  assert.ok(M.COMMON_STOCK.test('BRK.B'));
  assert.ok(!M.COMMON_STOCK.test('ABCDWS'));
  assert.ok(!M.COMMON_STOCK.test('XYZ.WS'));
});
