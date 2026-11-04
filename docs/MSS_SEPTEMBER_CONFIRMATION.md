# EURUSD early-retest investigation

Verified 2026-10-03, local Market Structure Shift tab: EURUSD, TF1 1h, TF2 1m, September 1, 2026. All HTF types except standalone swings; all four entry-array types enabled.

The reference explicitly labels CISD. The existing engine exclusively accepted native smartmoneyconcepts close-break CHOCH. On our stored feed the bearish FVG anchored 03:05 New York (1.16032–1.16038) activates at 03:08 and is touched at 03:09. Native close-break CHOCH breaks at 03:19 and is known at 03:20. That early touch is therefore excluded by the confirmation gate. Correction: the clearer user reference peaks around **1.1606**, consistent with the stored 1.16066 peak at 03:02. The previous reading of 1.167 was incorrect. At that peak the active containing hourly FVG is bullish; no bearish hourly OB/FVG contains it. The bearish context used for the later shift is an earlier-touched hourly IFVG.

Added an optional **CISD candidate** confirmation, separately labelled throughout table, chart line, markers and exported evidence. Default remains SMC CHOCH. This is an explicit research rule, not an assertion of certified ICT CISD: a preceding run of at least two directional bodies (neutral bodies may bridge it), confirmed three-right reversal swing, followed by a completed close through the first directional body's opening price. A new reversal extreme invalidates the candidate. The earliest eligible confirmation is never before the swing's known time. Arrays must originate and activate during formation; entries occur on a subsequent candle after both activation and confirmation.

On this stored feed the delivery run begins 02:52 at 1.16019. Its break candle is 03:18, known at 03:19. Thus the optional rule still cannot justify the 03:09 touch. The UI now exposes that rejected earlier touch rather than silently showing only a much later retest. No direction reversal or retroactive entry was introduced to force a reference match.

Entry datetime sorting defaults newest first, toggles from the header, sorts before pagination, keeps missing entries last, preserves stable ties, and resets pagination without resetting the selected story.

Validation: TypeScript, ESLint, causal CISD tests (both directions, close-only, neutral bridge, minimum run, future swing exclusion, new extreme invalidation), structural-plan checks, live API regression and browser verification. The default 29 native CHOCH investigations are unchanged except diagnostic metadata. Combined confirmation returns 441 contexts; these are investigations, not independent executable trades. API verification asserts no entry predates its confirmation or array activation. Browser verified both sort directions, selected CISD chart label, and the explicit 03:09 rejection note.

Evidence: `public/reports/mss-september-confirmation.json` and `public/reports/mss-early-retest-diagnostic.png`. Run `python scripts/test-mss-cisd.py` and `node scripts/test-mss-september-confirmation.cjs` (requires local server and stored feed).

## Wick-break follow-up: captured 03:15 entry

Added an explicit SMC CHOCH wick-break option (`close_break=False`). Close-break remains the default. Both modes use the original package's BOS/CHOCH definition, with exact kernel parity, rather than calling wick CHOCH a certified CISD.

A second scanner restriction discarded all events where BrokenIndex was earlier than the current prefix index. Native wick CHOCH on the 03:11 candle (broken level 1.1601699590682983, swing origin 02:51) first appears on the completed 03:14 prefix, known at 03:15, once its supporting swing becomes confirmed. The scanner now retains these later-observed wick breaks with **at=03:11 and knownAt=03:15**. It does not backdate availability to 03:12. Event identity remains stable and earliest knownAt is retained across later prefixes. Existing close-mode output is preserved.

This captures a subsequent SELL retest of the 03:05 FVG at **03:15 New York, 1.16032**, linked to the hourly bearish IFVG touched at 01:03. The 03:09 touch remains excluded. The screenshot's OB attribution is not reproduced by the stored causal package OB output; the matched HTF context is explicitly IFVG. Paper entry remains the selected replay candle close and can differ from the historical zone-edge entry.

Validation: `node scripts/test-mss-wick-entry.cjs` asserts the exact break, first observed time, FVG origin and 03:15 entry. The primitive parity test now covers close and wick modes over 572 prefixes plus complete scans for random, tied, flat and forex data. Default CHOCH regression remains identical. TypeScript and ESLint pass. Browser verified the 03:15 investigation, selected story, FVG replay control and wick-break chart label.

Evidence: `public/reports/mss-wick-entry-evidence.json`, `public/reports/mss-wick-entry-fixed.png`. Select **SMC CHOCH · wick break**, run Investigate, then inspect the 03:15 SELL IFVG context and its SELL FVG at 1.16032–1.16038.
