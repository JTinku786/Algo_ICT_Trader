# ICT Core website integration

Implemented 2026-10-01.

## Available

- ICT Core in desktop and mobile website navigation.
- Twelve months and 38 proposed implementation chapters, with searchable original overviews, learning prompts, source filenames, physical page anchors and source hashes.
- Learn, Replay, Checklist, Research and Integration views.
- Lazy-loaded shared daily/weekly native-candle replay using the existing instrument and timeframe controls.
- Manual study observations and provenance-bearing JSON export. Versioned browser-tab session storage preserves chapter, instrument, notes and study marks when navigating to other modules; storage failure leaves export available. This is not server-backed user progress.
- Links to existing Daily Bias, Reversal, Strategy Builder, Backtest, Machine Learning and Live Orders. These links open existing tools, without compiling chapter rules into their engines or attributing existing performance to the chapter.
- Zone browser lists all retained events in enabled categories, including historical events. Renderer displays two recent active events per category plus the selected event. Counts disclose retained versus drawn events; the existing 240-candle detector window remains.
- Candle charts explicitly explain that neutral candles are included and candle colours describe open/close direction.

## Remaining work

Full page-by-page diagram and condition review, exact chapter rule specifications, canonical event/service integration, audited detector replacement, chapter-specific setups/backtests, missing data adapters, ML feature mapping and paper/live promotion remain pending. Month 1 learning cards describe market conditions; they do not algorithmically classify those conditions. Checklists are manual learning observations rather than trade validation. Existing OB/breaker/FVG/IFVG replay annotations are local candidates.

## Verification

TypeScript compilation and targeted ESLint passed. Existing weekly replay regression suite passed, including three-bar confirmation, causal prefix invariance, neutral visibility and five native-frame API coverage.

Browser checks: chapter search; final chapter/source anchors; editable checklist and downloaded JSON content; AAPL replay through January 6; all four requested zone categories listed on daily and weekly charts; Strategy Builder navigation; study notes restored on return; no captured console errors. Client catalog validated against the registry for 38 unique chapter mappings, 12 months and matching source hashes/page anchors. PDF files and local source-directory paths are not included in the client catalog.

Screenshot: output/core-content/ict-core-workspace.png.
