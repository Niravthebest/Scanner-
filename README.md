# Momentum Scanner

A browser-based swing-trading scanner modelled on the setups Martin Luk has described publicly
(2025 US Investing Championship stock division winner, +969.8%). It finds three setups on daily
bars and sizes every position from its stop.

| Setup | Trigger | Stop |
|---|---|---|
| **Gap-up / EP** | Gaps ≥ 4% on ≥ 2x relative volume, closes in the upper half of the day | Day's low (live: opening-range low) |
| **Pullback** | Ran ≥ 20%, pulled back ≥ 3% in an uptrend (rising 21 EMA above the 50 EMA); today's low tags the 9/21/50 EMA or the anchored VWAP and price closes back above it | Below support or the day's low, whichever is lower |
| **Breakout** | Closes above a 10-day base whose range is ≤ 15%, on ≥ 1.5x volume, above the 50 EMA | Day's low |

All setups also require price ≥ $5, 20-day average dollar volume ≥ $5M and ADR ≥ 3%.
Every threshold can be changed under **Setup filters**.

**Sizing:** shares = (account × risk %) ÷ (entry − stop), capped at a maximum position size
(defaults: 0.5% risk, 20% max position). Stops wider than 4% are flagged *wide*. Ticking
rows builds a plan that totals your exposure and checks it against the exposure cap (35% by default).

## Run it

It is a static page with no build step:

```sh
npm start            # serves on http://localhost:8000 (or just open index.html)
npm test             # unit tests (Node 18+)
```

## Data sources

- **Demo:** fictional tickers (`XGAP`, `XPULL`, `XBASE`, …) built to show each setup and each filter.
- **CSV:** `symbol,date,open,high,low,close,volume`, one row per symbol per day, at least 60 days each.
- **Polygon.io:** enter an API key and a symbol list. The free tier allows 5 requests a minute and serves
  end-of-day data, so the default gap between requests is 12.5 s. The key stays in your browser and is
  saved only if you tick "Remember key".

## Backtest

`backtest.js` replays the scanner day by day over historical daily bars (no look-ahead: a signal uses
data up to that day's close) and simulates a portfolio with the same stop-based sizing.

```sh
node backtest-cli.js dataset.json --universe=symbols.txt --startDate=2023-07-01 \
  [--entryMode=breakout|close] [--trailEma=10] [--partialDays=3] [--minPriorRunPct=20] \
  [--marketFilter=QQQ:21] [--trades=trades.csv]
```

Rules: entry on a break of the signal day's high the next day (or at the signal close with
`--entryMode=close`); stop at the setup stop, with gap-downs filled at the open and bars that touch both
entry and stop counted as losses; sell a third after 3 days if in profit and move the stop to breakeven;
exit the rest on a close below the trailing EMA. 0.05% slippage per side.

### Minervini SEPA strategy

`strategies/minervini.js` is an alternative signal set based on Mark Minervini's published rules
(1997 USIC winner; +334.8% $1M+ stock-division record in 2021). It applies the Trend Template
(close > SMA50 > SMA150 > SMA200, rising SMA200, within 25% of the 52-week high, 30%+ above the low,
relative-strength rank >= 70 across the universe) and then requires a tight, contracting base with
drying volume. It buys a break of the base high and places the stop at the base low, capped at 8%.

```sh
node backtest-cli.js dataset.json --universe=symbols.txt --startDate=2024-01-02 --strategy=minervini \
  --riskPct=1.25 --maxPositionPct=25 --maxExposurePct=100 --marketFilter=SPY:50 \
  --partialAtR=2 --partialFraction=0.33 --trailEma=50 --trailAfterDays=0 --maxHoldDays=250 \
  [--s.baseDays=15 --s.maxBaseRangePct=15 --s.minRs=70 --s.maxStopPct=8]
```

Result warning: these settings were picked on Jan 2024 – Sep 2026, where they returned +99.8%. On
2017–2023 data, which the tuning never saw, the same settings returned −30.5% while SPY gained 111%.
Over 2017–2026 they returned +21% (max drawdown −52%) against SPY's +240%. Treat the rules as a
starting point, not a proven edge.

`--partialAtR=N` sells the partial when the close reaches entry + N x initial risk. With `--strategy`,
the CLI also prints an equal-weight buy-and-hold of the universe, as a check on survivorship bias.

## Intraday-entry backtest (Massive flat files)

`intraday-backtest.js` tests Luk-style execution: candidates are picked before the open (daily
scanner at the prior close on a momentum focus list, or a gap of 4%+ at the open), entry is a
buy-stop one tick above the opening-range high, the stop is the low of day at entry (skipped if
wider than 1x ADR or 6%), a stop hit later that day counts as a loss, and from the next day the
position is managed on daily bars as above.

Data comes from Massive (formerly Polygon.io) S3 flat files. `files.massive.com` must be allowed in
the environment's network settings. Credentials are read from the environment, never from files:

```sh
export MASSIVE_ACCESS_KEY=...  MASSIVE_SECRET_KEY=...
node tools/massive.js daily --from=2021-01-04 --to=2026-09-28 --out=daily.json      # full market, split-adjusted
node intraday-cli.js candidates --daily=daily.json --from=2021-06-01 --to=2026-09-28 --out=candidates.json
node tools/massive.js intraday --candidates=candidates.json --out=intraday.json      # 5-minute bars, candidate days only
node intraday-cli.js run --daily=daily.json --candidates=candidates.json --intraday=intraday.json --trades=trades.csv
```

The flat files are unadjusted; `tools/massive.js` back-adjusts splits it detects from exact-ratio
overnight gaps. ETFs are not flagged in the files: pass `--exclude=etfs.txt` to drop them.

## Files

- `scanner.js`: indicators, setup detection and position sizing (pure functions, also run under Node)
- `data.js`: demo generator, CSV parser, Polygon client
- `main.js`, `index.html`, `style.css`: the UI
- `backtest.js`, `backtest-cli.js`: daily-bar portfolio backtest
- `strategies/minervini.js`: Minervini SEPA signals for the backtest (`--strategy=minervini`)
- `intraday-backtest.js`, `intraday-cli.js`: opening-range-break backtest
- `tools/massive.js`: Massive flat-file downloader (daily + intraday)
- `test/`: tests

## Caveats

The scanner works on daily bars, so the stops approximate intraday levels. It is an educational tool,
not investment advice. Luk's own 2024 win rate was about 23%: this style makes money only when losers
stay small and a few winners run. Paper trade it before risking money.
