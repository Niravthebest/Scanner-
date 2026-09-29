(function () {
  'use strict';

  var S = window.Scanner;
  var D = window.ScannerData;
  var SETTINGS_KEY = 'scanner.settings.v1';
  var KEY_KEY = 'scanner.polygonKey.v1';

  var RISK_FIELDS = [
    ['accountSize', 'Account size ($)', 100],
    ['riskPct', 'Risk per trade (%)', 0.05],
    ['maxPositionPct', 'Max position (% of account)', 1],
    ['maxExposurePct', 'Max total exposure (%)', 1],
    ['maxStopPct', 'Max stop width (%)', 0.1]
  ];
  var FILTER_FIELDS = [
    ['minPrice', 'Min price ($)', 0.5],
    ['minAvgDollarVolM', 'Min avg $ volume ($M)', 0.5],
    ['minAdrPct', 'Min ADR (%)', 0.1],
    ['minGapPct', 'Gap-up: min gap (%)', 0.5],
    ['minRvol', 'Gap-up: min rel. volume (x)', 0.1],
    ['minPriorRunPct', 'Pullback: min prior run (%)', 1],
    ['runLookback', 'Pullback: run lookback (days)', 1],
    ['minPullbackPct', 'Pullback: min off high (%)', 0.5],
    ['supportTolPct', 'Pullback: support tolerance (%)', 0.1],
    ['baseLength', 'Breakout: base length (days)', 1],
    ['maxBaseRangePct', 'Breakout: max base range (%)', 0.5],
    ['breakoutMinRvol', 'Breakout: min rel. volume (x)', 0.1]
  ];

  var state = {
    source: 'demo',
    settings: loadSettings(),
    dataset: null,
    results: [],
    selected: {},
    abort: null
  };

  // ---------- storage (best effort: may be unavailable) ----------

  function loadSettings() {
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return S.withDefaults(saved);
    } catch (e) {
      return S.withDefaults({});
    }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
  }

  // ---------- formatting ----------

  var money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmt(n, d) { return isFinite(n) ? n.toFixed(d == null ? 2 : d) : '–'; }
  function pct(n, d) { return isFinite(n) ? (n > 0 ? '+' : '') + n.toFixed(d == null ? 1 : d) + '%' : '–'; }
  function signClass(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'className') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, isError) {
    var s = $('status');
    s.textContent = msg;
    s.classList.toggle('error', !!isError);
  }

  // ---------- settings form ----------

  function buildFields(containerId, fields) {
    var box = $(containerId);
    box.innerHTML = '';
    fields.forEach(function (f) {
      var input = el('input', { type: 'number', step: String(f[2]), min: '0', id: 'set-' + f[0] });
      input.value = state.settings[f[0]];
      input.addEventListener('input', function () {
        var v = parseFloat(input.value);
        if (isFinite(v) && v >= 0) {
          state.settings[f[0]] = v;
          saveSettings();
          rescan();
        }
      });
      box.appendChild(el('label', { className: 'field' }, [el('span', { text: f[1] }), input]));
    });
  }

  function buildSettings() {
    buildFields('risk-fields', RISK_FIELDS);
    buildFields('filter-fields', FILTER_FIELDS);
  }

  // ---------- data source tabs ----------

  function selectSource(src) {
    state.source = src;
    document.querySelectorAll('.tab').forEach(function (t) {
      t.setAttribute('aria-selected', String(t.dataset.source === src));
    });
    document.querySelectorAll('.source-panel').forEach(function (p) {
      p.hidden = p.dataset.panel !== src;
    });
  }

  // ---------- scanning ----------

  function rescan() {
    if (!state.dataset) return;
    var out = S.scan(state.dataset, state.settings);
    state.results = out.results;
    // Keep plan selections that still have a setup.
    var still = {};
    out.results.forEach(function (r) { if (r.best && state.selected[r.symbol]) still[r.symbol] = true; });
    state.selected = still;
    renderResults();
    renderCalc();
    return out;
  }

  function loadDataset(dataset, label, errors) {
    state.dataset = dataset;
    var out = rescan();
    var found = out.results.filter(function (r) { return r.best; }).length;
    var msg = label + ': ' + out.results.length + ' symbols scanned, ' + found + ' with a setup.';
    if (out.skipped.length) {
      msg += ' Skipped (under ' + S.MIN_BARS + ' days of data): ' + out.skipped.join(', ') + '.';
    }
    if (errors && errors.length) msg += ' Issues: ' + errors.slice(0, 5).join('; ') + '.';
    setStatus(msg, !out.results.length);
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('Could not read file')); };
      r.readAsText(file);
    });
  }

  async function run() {
    try {
      if (state.source === 'demo') {
        loadDataset(D.demoDataset(42), 'Demo data');
        return;
      }

      if (state.source === 'csv') {
        var file = $('csv-file').files[0];
        if (!file) return setStatus('Choose a CSV file first.', true);
        var text = await readFile(file);
        var fallbackSym = file.name.replace(/\.[^.]+$/, '').toUpperCase();
        var parsed = D.parseCsv(text, fallbackSym);
        if (!Object.keys(parsed.dataset).length) {
          return setStatus('No usable rows. ' + parsed.errors.join('; '), true);
        }
        loadDataset(parsed.dataset, file.name, parsed.errors);
        return;
      }

      // Polygon
      var key = $('polygon-key').value.trim();
      var symbols = D.parseSymbols($('polygon-symbols').value);
      if (!key) return setStatus('Enter your Polygon.io API key.', true);
      if (!symbols.length) return setStatus('Enter at least one symbol.', true);
      try {
        if ($('polygon-remember').checked) localStorage.setItem(KEY_KEY, key);
        else localStorage.removeItem(KEY_KEY);
      } catch (e) { /* ignore */ }

      var delay = Math.max(0, parseFloat($('polygon-delay').value) || 0) * 1000;
      state.abort = new AbortController();
      toggleRunning(true);
      var res = await D.fetchPolygon(symbols, key, {
        delayMs: delay,
        signal: state.abort.signal,
        onProgress: function (i, n, sym) {
          if (sym) setStatus('Fetching ' + sym + ' (' + (i + 1) + ' of ' + n + ')…');
        }
      });
      if (!Object.keys(res.dataset).length) {
        return setStatus('No data returned. ' + res.errors.slice(0, 5).join('; '), true);
      }
      loadDataset(res.dataset, 'Polygon.io', res.errors);
    } catch (e) {
      setStatus(e.message === 'Cancelled' ? 'Cancelled.' : 'Error: ' + e.message, e.message !== 'Cancelled');
    } finally {
      toggleRunning(false);
      state.abort = null;
    }
  }

  function toggleRunning(on) {
    $('run').disabled = on;
    $('cancel').hidden = !on;
  }

  // ---------- results ----------

  function badgeClass(type) {
    if (type === 'Pullback') return 'pullback';
    if (type === 'Breakout') return 'breakout';
    return 'gap';
  }

  function setupCell(r) {
    var td = el('td', { className: 'setup' });
    if (!r.best) {
      td.textContent = r.failedFilters.length ? 'Filtered: ' + r.failedFilters.join(', ') : 'No setup';
      return td;
    }
    r.setups.forEach(function (s) {
      td.appendChild(el('span', {
        className: 'badge ' + badgeClass(s.type),
        text: s.type + (s.support ? ' · ' + s.support : '')
      }));
    });
    if (r.best.wideStop) td.appendChild(el('span', { className: 'badge wide', text: 'wide stop' }));
    td.appendChild(el('span', { className: 'note', text: r.best.note }));
    return td;
  }

  function numCell(text, cls) {
    return el('td', { className: 'num ' + (cls || ''), text: text });
  }

  function renderResults() {
    var showAll = $('show-all').checked;
    var rows = state.results.filter(function (r) { return showAll || r.best; });
    var table = $('results');
    var tbody = table.querySelector('tbody');
    tbody.innerHTML = '';

    $('results-empty').hidden = rows.length > 0;
    table.hidden = rows.length === 0;
    if (!rows.length) {
      $('results-empty').textContent = state.dataset
        ? 'No setups today with these settings. Tick "Show symbols without a setup" to see why.'
        : 'Run a scan to see setups.';
    }

    rows.forEach(function (r) {
      var m = r.metrics;
      var b = r.best;
      var size = b && b.size;
      var box = el('input', { type: 'checkbox', 'aria-label': 'Add ' + r.symbol + ' to plan' });
      box.checked = !!state.selected[r.symbol];
      box.disabled = !b || !size.valid;
      box.addEventListener('change', function () {
        if (box.checked) state.selected[r.symbol] = true;
        else delete state.selected[r.symbol];
        renderPlan();
      });
      var symCell = el('td', {}, [
        el('span', { className: 'sym', text: r.symbol }),
        el('span', { className: 'note', text: r.date })
      ]);

      tbody.appendChild(el('tr', { className: b ? '' : 'no-setup' }, [
        el('td', {}, [box]),
        symCell,
        setupCell(r),
        numCell(fmt(m.price)),
        numCell(pct(m.changePct), signClass(m.changePct)),
        numCell(pct(m.gapPct), signClass(m.gapPct)),
        numCell(fmt(m.rvol, 1) + 'x'),
        numCell(fmt(m.adrPct, 1) + '%'),
        numCell([m.vsEma9, m.vsEma21, m.vsEma50].map(function (v) { return pct(v, 0); }).join(' / ')),
        numCell(b ? fmt(b.stop) : '–'),
        numCell(b ? fmt(b.stopPct, 1) + '%' : '–', b && b.wideStop ? 'neg' : ''),
        numCell(size && size.valid ? String(size.shares) : '–'),
        numCell(size && size.valid ? money.format(size.positionValue) + ' (' + fmt(size.positionPct, 0) + '%)' : '–'),
        numCell(size && size.valid ? money.format(size.dollarRisk) : '–')
      ]));
    });
    renderPlan();
  }

  function renderPlan() {
    var plan = $('plan');
    var positions = state.results
      .filter(function (r) { return state.selected[r.symbol] && r.best && r.best.size.valid; })
      .map(function (r) { return r.best.size; });
    if (!positions.length) {
      plan.hidden = true;
      return;
    }
    var sum = S.planSummary(positions, state.settings);
    plan.hidden = false;
    plan.classList.toggle('over', sum.overCap);
    plan.textContent =
      'Plan: ' + sum.count + ' position' + (sum.count === 1 ? '' : 's') +
      ' · ' + money.format(sum.value) + ' exposure (' + fmt(sum.exposurePct, 0) + '% of account, cap ' +
      fmt(state.settings.maxExposurePct, 0) + '%)' +
      ' · ' + money.format(sum.dollarRisk) + ' at risk (' + fmt(sum.riskPct, 2) + '%)' +
      (sum.overCap ? ' · Over the exposure cap: drop a position or size down.' : '');
  }

  // ---------- calculator ----------

  function renderCalc() {
    var entry = parseFloat($('calc-entry').value);
    var stop = parseFloat($('calc-stop').value);
    var out = $('calc-out');
    if (!isFinite(entry) || !isFinite(stop)) {
      out.textContent = 'Enter an entry and a stop below it.';
      return;
    }
    var s = S.positionSize({
      accountSize: state.settings.accountSize,
      riskPct: state.settings.riskPct,
      maxPositionPct: state.settings.maxPositionPct,
      entry: entry,
      stop: stop
    });
    if (!s.valid) {
      out.textContent = s.reason + '.';
      return;
    }
    out.textContent =
      'Buy ' + s.shares + ' shares = ' + money.format(s.positionValue) + ' (' + fmt(s.positionPct, 1) +
      '% of account). Stop is ' + fmt(s.stopPct, 2) + '% away; if hit you lose ' + money.format(s.dollarRisk) +
      ' (' + fmt(s.riskPctActual, 2) + '%).' +
      (s.cappedBy === 'position cap' ? ' Limited by the max position size.' : '') +
      (s.stopPct > state.settings.maxStopPct ? ' Warning: stop is wider than your max stop width.' : '');
  }

  // ---------- init ----------

  function init() {
    buildSettings();
    try {
      var savedKey = localStorage.getItem(KEY_KEY);
      if (savedKey) {
        $('polygon-key').value = savedKey;
        $('polygon-remember').checked = true;
      }
    } catch (e) { /* ignore */ }

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { selectSource(t.dataset.source); });
    });
    $('run').addEventListener('click', run);
    $('cancel').addEventListener('click', function () { if (state.abort) state.abort.abort(); });
    $('show-all').addEventListener('change', renderResults);
    $('calc-entry').addEventListener('input', renderCalc);
    $('calc-stop').addEventListener('input', renderCalc);
    $('reset').addEventListener('click', function () {
      state.settings = S.withDefaults({});
      saveSettings();
      buildSettings();
      rescan();
      renderCalc();
    });

    // Show something useful straight away.
    loadDataset(D.demoDataset(42), 'Demo data');
  }

  init();
})();
