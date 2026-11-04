# Titania Assistant service

Run locally from the project root:

```powershell
python -m pip install -r backend/titania_assistant/requirements.txt
uvicorn backend.titania_assistant.main:app --host 127.0.0.1 --port 8100
```

The Next.js panel talks only to `/api/assistant/chat`. That route removes browser-supplied identity fields and attaches server-resolved context before forwarding to this service.

## Required production configuration

- `TITANIA_ENV=production`
- `TITANIA_ASSISTANT_SHARED_SECRET`: same secret in Next.js and FastAPI.
- `TITANIA_ASSISTANT_URL`: private FastAPI service URL, configured in Next.js.
- `OPENROUTER_API_KEY`: configured on the FastAPI inference host; never use a `NEXT_PUBLIC_` name. The Vercel proxy does not need this key unless it hosts inference itself.
- `OPENROUTER_MODEL`: the general chat model sent to OpenRouter on each request. This is required because an OpenRouter API key does not imply a model selection.
- `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, and `LANGSMITH_PROJECT=ICT_ALGO_TRADER`: optional request tracing. Titania records metadata, latency, lane, model, and guardrail outcome by default; it does not export raw messages, answers, account context, or provider keys unless `LANGSMITH_CAPTURE_CONTENT=true` is deliberately enabled.
- An authenticated-user resolver in `src/app/api/assistant/chat/route.ts`.
- Either OpenRouter credentials or a reachable Ollama endpoint.

Production requests without a valid signed BFF envelope are rejected. The included development identity resolver is deliberately disabled when `NODE_ENV=production`; replace it with the platform session/JWT integration before deployment.

Use [`.env.example`](../../.env.example) as the local/Vercel variable checklist. Vercel environment variables must be configured separately for Preview and Production as appropriate; the FastAPI host needs the same private inference and signing values.

Recommendations are only emitted from fresh, source-backed candidate rows with valid entry/stop/target geometry. The LLM renders an explanation; deterministic backend code owns eligibility, ranking, and position sizing.

## Conversation memory

Each browser chat has a UUID session ID. The UI retains up to 12 local chat windows and the service retains the last 20 content-only turns for the authenticated user/session in Postgres (SQLite only for local fallback). This supports follow-up questions after refresh without sharing memory across users. Provider `reasoning_details` and hidden reasoning are never persisted or rendered.

## Evaluation corpus

Generate the 10,000-case synthetic regression corpus with:

```powershell
python backend/titania_assistant/evals/generate_regression_cases.py
```

The corpus covers recommendation/no-trade behavior, recent-performance aggregates, education, multilingual continuity, strict mode, source rendering, protected-data refusal, unsupported-information handling, prompt injection, and session-memory isolation. It contains no real customer data and is ready to import into a LangSmith dataset or a local evaluator.

## Internet context and RAG

Titania has a bounded read-only Internet context tool for current Asia-market questions. It retrieves up to three recent Google News RSS headlines, labels them as untrusted external text, and cites the source. It does not grant arbitrary browser, filesystem, or write access to the model.

Build the local approved-document index after changing `TITANIA_RAG_ROOTS`:

```powershell
python -m backend.titania_assistant.rag --rebuild
```

The default roots are `ICT_DataScience`, `ICT_Automation`, and strategy/trading-named files in `Downloads`. PDFs, Markdown, text documents, and notebook Markdown cells are indexed locally with source file/page citations. Unrelated mixed-folder personal documents in Downloads are intentionally excluded. The SQLite index is ignored by Git.
