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

## Files

- `scanner.js`: indicators, setup detection and position sizing (pure functions, also run under Node)
- `data.js`: demo generator, CSV parser, Polygon client
- `main.js`, `index.html`, `style.css`: the UI
- `test/scanner.test.js`: tests

## Caveats

The scanner works on daily bars, so the stops approximate intraday levels. It is an educational tool,
not investment advice. Luk's own 2024 win rate was about 23%: this style makes money only when losers
stay small and a few winners run. Paper trade it before risking money.
