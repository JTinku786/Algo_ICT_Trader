# Algo ICT Trader — 6-Month CEO Roadmap (Aug 2026 – Jan 2027)

**Prepared:** 2026-07-19 · **Owner:** CEO / Reddy · **Cadence:** Daily 30-min heartbeat per team
**Mission:** The single trusted platform to learn, build, backtest, and trade ICT concepts end-to-end — delivered at TradeZella / Kite / MetaTrader quality, worthy of a demo to Michael J. Huddleston himself.

---

## 1. Where We Are Today (verified against the live site, 2026-07-19)

**Working and live:**

| Module | State |
| --- | --- |
| Realtime Orders | Live. S03 + S16, US + India, 71 signals, risk-governance panel |
| Strategy Builder | v1 live. S-ICT 30M→5M contract, S&P 500 + Forex Top-10 runner-ready, NIFTY/BANKNIFTY behind adapter gate, JSON/PowerShell handoff to backtest runner |
| Backtest | Full tester: sizing, commission/slippage, OOS holdout, equity/DD, monthly R |
| Machine Learning | 2 models live (S03, S16), 8,180 orders scored, test AUC 0.729 / KS 34.5% |
| Trade Journal / Stonk Ledger | Live, filters across backtest + realtime, us/india/forex |
| Strategy Blogs | 29 articles (core automation, A-series, concept library) |
| Monitoring / Live Orders | Live Postgres over zrok, Discord alerts, anomaly queue |
| Deployments | US Production ready (S16-only), India staged, Forex sandbox = draft |

**Honest gaps the plan must fix:**

1. **Edge is not yet proven live** — current filtered snapshot shows win rate 36.5%, profit factor 0.9 (below our own 1.0 floor), net −13.81R, guardrail status RISK REVIEW. Fixing this is priority zero; nothing else matters if the edge isn't real.
2. **Model drift** — S03 PSI ≈ 0.24, brushing the 0.25 rebuild threshold. A model refresh is due.
3. **LLM assistant is a placeholder** — sidebar stub only.
4. **Forex is sandbox/draft** — universe is wired in the builder but no forex data pipeline, session logic, or deployment path is production-grade.
5. **No client layer** — no accounts, auth tiers, client onboarding, support desk, or CEO oversight view.
6. **Strategy Builder is single-contract** — one fixed S-ICT sequence; no dropdown-driven custom strategies, no image/video attachments.
7. **Cline_Testing (Titania) has features we haven't ported** — Command Center, Risk & Compliance Hub, Trade Replay, broker abstraction (Paper/Alpaca/IBKR), and a chat assistant with image/PDF upload.

---

## 2. North-Star Outcomes (by end of January 2027)

1. **Forex fully live end-to-end** (data → builder → backtest → realtime → deployment) — by **end of September 2026**.
2. **First $25k in client/funded accounts — by end of October 2026** (3 months).
3. **LLM assistant shipped** and answering strategy, trade, and anomaly questions with platform data.
4. **Strategy Builder v2**: dropdown data points, timeframes, liquidity-level stops, RR targets, image/video attachments, one-click backtest.
5. **CEO Command Center**: live strategies, per-client performance, risk, and funnel in one view.
6. **Client-grade product**: accounts, onboarding, support, education hub — the ICT learning + trading one-stop.
7. **The Huddleston Demo package**: polished narrative, live walkthrough, and printed evidence of edge.

---

## 3. Month-by-Month Plan

### Month 1 — August 2026 · "Prove the edge, start Forex"

The theme is credibility before growth.

- **Research + Data Science:** S03 model rebuild (PSI-triggered). Root-cause the PF 0.9 / 36.5% live window: regime, slippage, or contract drift vs backtest. Ship a written edge-verification report — this becomes a funding artifact.
- **Data Engineering:** Forex pipeline v1 — tick/1M data for the Top-10 universe, London+NY session calendars, pip/lot/spread normalization, weekend-gap handling. Parity checks vs existing US/India candles.
- **Software Development:** Port from Cline_Testing → Algo_ICT_Trader: Command Center layout, Risk Hub violations log, broker abstraction layer skeleton. Fix "refreshed 20653d ago" style polish bugs across Live Orders.
- **Product + Design:** Strategy Builder v2 spec (see §5). Client-facing information architecture.
- **Analytics:** Define the platform KPI tree (edge KPIs, product KPIs, funnel KPIs) and instrument it.
- **Legal/Risk:** Begin entity + regulatory review for handling client funds (see §7 — this gates the funding model).
- **Marketing/Social:** Start the content engine — 2 strategy-blog-derived videos/week (scripts already exist in ICT_Automation), Discord community opened.

**Gate to Month 2:** forex candles flowing with QA parity; S03 refresh in shadow mode; edge report published.

### Month 2 — September 2026 · "Forex live end-to-end" *(hard deadline)*

- **Data Engineering + Software:** Forex backtest parity in the Backtest tab (pip-based R, spread costs). Forex Sandbox → Staged → Production path in Deployments. Realtime forex signals for 2–3 majors (EURUSD, GBPUSD first).
- **Research:** Validate S-ICT + S16 contracts on forex with walk-forward + OOS gates (same promotion policy as US: 100+ OOS trades, PF ≥ 1.5, DD ≤ 8R). Do **not** relax gates to hit the date — ship the pairs that pass.
- **Software (LLM):** LLM Assistant MVP (see §6): OpenRouter + Vercel AI SDK, tool-calling into existing APIs (orders, backtest, ML insights, blogs). Ollama as local fallback.
- **Product:** Strategy Builder v2 build starts. Client account model + auth design.
- **Marketing:** "Forex is live" launch content queued; waitlist landing page collecting emails.

**Gate to Month 3:** at least 1 forex pair in production deployment; LLM assistant answering read-only questions in the sidebar.

### Month 3 — October 2026 · "First clients, first $25k"

- **Product + Software:** Client accounts v1 — signup, tiered access (Learn / Backtest / Live-follow), client dashboard (their strategies, their performance). Payment rails (Stripe or Razorpay for India).
- **CEO View v1 (see §8):** live strategies, aggregate + per-client P&L, risk utilization, anomaly feed.
- **Finance:** Pricing finalized (see §7). Billing, invoicing, revenue dashboard. Track "$ in accounts" daily on the CEO view.
- **Sales/Clients:** Convert waitlist + existing community. Target: **$25k across client accounts/subscriptions by Oct 31.**
- **Support:** Customer-support foundation — helpdesk (Crisp/Intercom-class), docs site seeded from the 29 strategy blogs, SLA policy. LLM assistant handles tier-1 questions.
- **Research:** S16 forex expansion; India adapter gate opened if validation passes.

**Gate to Month 4:** ≥ $25k committed; support desk live; churn/NPS instrumentation on.

### Month 4 — November 2026 · "Broker-grade execution + journal excellence"

- **Software:** Broker abstraction to production — Paper adapter for all clients, Alpaca (US) live, Indian broker (Zerodha Kite Connect) integration started, MT5 bridge scoped for forex.
- **Product:** TradeZella-parity journal — trade replay (port from Cline_Testing), emotion/discipline tagging, weekly review reports, shareable trade cards.
- **ML/Data Science:** Risk-probability gating moves from shadow → advisory in production UI (clients see the score and band on every signal).
- **Design:** Mobile/responsive pass on all client-facing pages.
- **Marketing:** Case studies from first client cohort; referral program.

### Month 5 — December 2026 · "Education hub + scale the funnel"

- **Product:** ICT Academy — structured learning paths built on the blog library + videos, quizzes, progress tracking, certificate. This is the "single platform to learn ICT clearly" pillar.
- **Software:** Strategy Builder v2 GA to clients (build → backtest → paper-deploy without touching code). Slack/WhatsApp/Telegram alert channels beside Discord.
- **Analytics:** Cohort analysis — learning-to-trading conversion, retention, LTV.
- **Finance/Legal:** Close the books on H2; confirm compliance posture for scaling client funds.
- **Ops:** Move off zrok/localhost — proper cloud deployment, uptime SLOs, on-call rotation.

### Month 6 — January 2027 · "Polish, trust, and the Huddleston demo"

- **All teams:** Hardening sprint — security review, load tests, data-integrity audits, disaster recovery.
- **Product/Design:** Final UX polish to Kite/MetaTrader standard; white-glove onboarding flow.
- **The Demo:** A scripted end-to-end walkthrough for Michael Huddleston: concept blog → builder → validated backtest → ML score → live execution → journal review → client view — plus a printed edge-evidence dossier. Every claim traceable to data.
- **CEO:** H1-2027 planning off the KPI baseline; Series-seed / investor conversations if metrics support it.

---

## 4. Team Workstreams (who owns what, all 6 months)

| Team | Primary ownership | Daily heartbeat focus |
| --- | --- | --- |
| Research | Strategy contracts, walk-forward validation, promotion gates | Gate status per strategy/market |
| Data Science | ML scorecards, drift/PSI, model refresh, risk-prob gating | Model health, scored-order counts |
| Data Engineering | Candle/tick pipelines (US, India, **forex**), data QA, storage | Pipeline freshness, parity checks |
| Software Development | Web app, APIs, broker adapters, LLM assistant, infra | Ship log, blockers, uptime |
| Analytics | KPI tree, funnels, cohort/retention, experiment readouts | Metric movements vs target |
| Product | Roadmap, specs (Builder v2, accounts, academy), prioritization | Spec status, launch checklist |
| Finance | Pricing, billing, revenue tracking, $25k milestone, runway | Cash in, MRR, CAC |
| Legal | Entity, client-funds regulation, ToS/privacy, broker agreements | Open legal risks |
| Risk Management | Guardrails, drawdown policy, kill switches, client risk limits | Guardrail breaches, open risk R |
| Social Media & Marketing | Content engine, launches, community, waitlist → conversion | Content shipped, signups |
| Clients (source) | Feedback loop, beta cohort, testimonials | Top 3 client asks |

Heartbeat rules: 30 minutes, same time daily, written note in the tracker (yesterday / today / blockers / metric). Weekly Friday demo — every team shows something running, not slides.

---

## 5. Strategy Builder v2 (the flagship feature)

Goal: a trader who cannot code builds a valid ICT strategy in under 10 minutes.

- **Dropdown-driven contract steps:** data points (liquidity levels, FVG/iFVG, OB, breaker, sweep, MSS/BOS, premium/discount), timeframe per step (W/D/4H/1H/30M/15M/5M/1M), session/killzone windows.
- **Stops from structure:** SL selector bound to liquidity-level data points (5M reaction, 30M/1H structure) — not arbitrary ticks.
- **Targets:** RR presets + real untapped-liquidity targets (T1/T2/T3), exactly as the current S-ICT preview teaches.
- **Attachments:** image upload + video link per strategy (the "this is the setup" evidence) — chat upload code in Cline_Testing is reusable.
- **One-click backtest:** builder → runner handoff already exists; extend it so the run triggers from the UI and results land back in the Backtest tab automatically.
- **Guardrails stay:** preflight validation, scratch-tables-first, promotion gates unchanged. Clients can build anything; only validated strategies can deploy.

---

## 6. LLM Assistant (close the last placeholder)

**Recommended stack:** Vercel AI SDK inside the existing Next.js app + **OpenRouter** (we have credits) with a strong cheap default (e.g. Claude Haiku / Gemini Flash class) and premium model escalation; **Ollama** as the self-hosted fallback for cost control and offline dev. One provider interface, so swapping models is config, not code.

**Phase 1 (Sep):** read-only Q&A with tool-calling into existing APIs — "why did this trade lose?", "summarize today's anomalies", "explain S03 breaker rules" (grounded in the 29 blogs).
**Phase 2 (Oct–Nov):** journal summaries, daily execution digests to Discord/Slack, anomaly-queue triage drafts.
**Phase 3 (Dec+):** builder copilot — turn a described setup into a draft Builder v2 configuration. Never places trades; suggestions only, always behind the same promotion gates.

---

## 7. Funding: $25k in Accounts by October 31

Realistic mix (own + client money), with legal gating:

1. **Founder/prop capital:** seed the live accounts with our own verified-edge capital first — proof before asking others.
2. **Subscriptions (cleanest legally):** Learn tier ($19–29/mo), Builder+Backtest tier ($49–79/mo), Signals/Live-follow tier ($99–149/mo). 100–150 paying users ≈ $8–12k MRR territory by month 3 is aggressive but possible with the content engine + waitlist.
3. **Client trading accounts:** clients trade **their own broker accounts** using our signals/automation (broker-connect model, like MT4/Kite ecosystems). This avoids us holding client funds.
4. **Managed funds — only if legal clears it.** Pooling or managing other people's money triggers licensing (SEBI PMS/RIA in India, SEC/CFTC/NFA in the US). Legal decides the structure before a single external dollar lands. *(This is a plan, not legal or financial advice — the legal team owns the final structure.)*

Funnel math to track weekly: content views → site visits → waitlist → trials → paid → $ in accounts.

---

## 8. CEO Command Center (separate view)

One screen, refreshed live:

- **Strategies live now:** per market (US/India/Forex), state (shadow/staged/production), today's signals and open R.
- **Performance:** equity curve, PF, win rate, expectancy — per strategy and blended, backtest vs live overlay.
- **Clients:** count by tier, MRR, $ in accounts, top/bottom client performance, churn flags.
- **Risk:** guardrail status, open planned risk vs limit, drawdown vs policy, kill-switch state.
- **Anomalies + LLM digest:** the assistant's morning summary of what needs CEO attention.
- **Team pulse:** heartbeat compliance and blockers per team.

Build note: 80% of the data already exists in Postgres (realtime_production_* tables, backtest tables, ML tables). This is mostly a read-model + one new page, plus client tables once accounts ship in October.

---

## 9. KPIs and Gates (reviewed every Friday)

| KPI | Now | Month 3 target | Month 6 target |
| --- | --- | --- | --- |
| Live profit factor (blended) | 0.9 | ≥ 1.2 | ≥ 1.5 |
| Markets in production | 1 (US S16) | 3 (US, India, Forex) | 3, multi-strategy |
| $ in accounts / MRR | $0 | **$25k** | $60k+ |
| Paying users | 0 | 100+ | 400+ |
| LLM assistant | placeholder | Phase 1 live | Phase 3 copilot |
| Model health (PSI) | 0.24 (monitor) | < 0.10 post-refresh | < 0.10 sustained |
| Support first-response | — | < 4h | < 1h |
| Uptime | localhost/zrok | 99% cloud | 99.9% |

**Hard rules:** no strategy promotes without passing the existing gates; no client funds accepted before legal sign-off; the forex deadline never overrides validation gates — we ship what passes.

---

## 10. Top Risks

1. **Edge risk (existential):** live PF < 1. Mitigation: Month-1 root-cause + model refresh; grow the audience with education/backtesting products (which don't require live edge) while the edge is being proven.
2. **Regulatory risk:** client money without licenses. Mitigation: subscriptions + broker-connect model first; legal gates everything else.
3. **Forex data quality:** spreads/gaps can silently break R math. Mitigation: parity QA suite before any forex backtest is trusted.
4. **Single-founder infra:** localhost + zrok is not client-grade. Mitigation: Month-5 cloud migration, on-call.
5. **Scope creep:** 10 modules and 11 teams can drown in breadth. Mitigation: monthly gates above — each month has one theme; heartbeats kill drifting work fast.

---

*Sources: live review of localhost:3000 (all 10 modules), Algo_ICT_Trader repo, Cline_Testing (Titania / ICT Prop Firm OS docs), ICT_DataScience ROADMAP.md, ICT_Automation blueprints.*
