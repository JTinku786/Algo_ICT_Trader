# Charles Schwab registration

App: **Algo ICT Trader**. Created successfully through the developer portal;
portal status at registration: **Ready For Use**, environment **Production**.

- Machine name: `prod-saitejareddy123gmailcom-d33726c1-c7cd-4667-9b80-66de9418b618`
- Creator: `saitejareddy123@gmail.com`
- Portal creation, key-issued and last-modified dates: **2026-10-29**.
  These are the portal's displayed dates, retained as supplied.
- Callback: `https://127.0.0.1`
- Order-related request limit: **0/minute**
- Products: **Accounts and Trading Production**, **Market Data Production**
- Description: Personal ICT research dashboard: market data, account balances,
  positions and order history. Initial integration for data and account monitoring.

## Local configuration

The client ID and client secret are saved only in Git-ignored `.env.local` as
`SCHWAB_CLIENT_ID` and `SCHWAB_CLIENT_SECRET`. This file also contains
`SCHWAB_CALLBACK_URL`, `SCHWAB_ORDER_LIMIT_PER_MINUTE` and
`SCHWAB_APP_MACHINE_NAME`. Do not copy real credentials into this document,
memory, browser bundles, screenshots or `.env.example`.

Account Management > Schwab checks server-side credential presence through
`/api/account-management/schwab`. The response contains only allowlisted setup
metadata and boolean readiness checks, never credentials or account information.
Each deployed host needs its own private environment configuration; saving local
credentials does not configure Vercel or ICT_Automation.

## Connection boundary

**OAuth is not connected.** No tokens, account consent, market-data retrieval,
balance/position/history retrieval or broker execution have been verified.
The registered loopback callback does not yet have an implemented OAuth handler.
Next implement that flow, obtain account authorization, then verify a read-only
API response before marking the connection operational. Trading is disabled in
this integration. The registered request limit is a throttle, not an OAuth scope.

Registration record: [Schwab app details](https://developer.schwab.com/dashboard/apps/app/fce32d82-dd8c-4163-90f3-393dfb5dd3d1).
