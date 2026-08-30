# momentWealth — Live News Architecture

How the auto-refreshing "Live wire" panel on [momentwealth.html](../docs/momentwealth.html) works end to end.

```mermaid
flowchart LR
    subgraph Browser["Visitor's browser"]
        A["docs/momentwealth.html<br/>(GitHub Pages, static)"]
    end

    subgraph GCP["GCP project: protean-fabric-467500-a5 (asia-south1)"]
        B["Cloud Run: momentwealth-backend<br/>Express, GET /api/news"]
        C["In-memory cache<br/>30-min TTL, lazy refresh"]
        D["Secret Manager<br/>apify-token:latest"]
    end

    subgraph External["External data sources"]
        E["Apify Actor<br/>economic-times-intelligence-<br/>scraper-markets-policy-data"]
        F["INDmoney MCP<br/>(pulled manually/on schedule<br/>by Claude, baked into static HTML)"]
    end

    A -- "fetch every 30 min<br/>+ on tab focus" --> B
    B -- reads --> C
    C -- "cache stale?<br/>run-sync-get-dataset-items" --> E
    B -. "reads token at<br/>container start" .-> D
    F -. "manual/scheduled<br/>regeneration, git push" .-> A

    style A fill:#EEF1EA,stroke:#0F6B4C,color:#14211C
    style B fill:#E4F0E9,stroke:#0F6B4C,color:#14211C
    style C fill:#FFFFFF,stroke:#DDE3DA,color:#14211C
    style D fill:#F5EEDD,stroke:#9A7B1F,color:#14211C
    style E fill:#F8E7E4,stroke:#B23A2E,color:#14211C
    style F fill:#F8E7E4,stroke:#B23A2E,color:#14211C
```

## Components

| Piece | What it is | Where |
|---|---|---|
| Frontend | Static HTML/CSS/JS, no build step | [`docs/momentwealth.html`](../docs/momentwealth.html), served by GitHub Pages |
| Backend | Express service, one route (`GET /api/news`) | [`momentwealth-backend/`](.), deployed to Cloud Run |
| Cloud project | `protean-fabric-467500-a5`, region `asia-south1` | Google Cloud |
| Secret | `apify-token` (Secret Manager) | mounted into Cloud Run as `APIFY_TOKEN` env var via `--set-secrets` |
| News source | Apify actor `complex_intricate_networks/economic-times-intelligence-scraper-markets-policy-data` | called via `run-sync-get-dataset-items` |
| Market/fund data | INDmoney MCP tools | pulled on demand by Claude and written directly into the static HTML — **not** live-fetched by the browser |

## Request flow (live news panel)

1. Browser loads `momentwealth.html`; its JS immediately calls `GET /api/news` on the Cloud Run service, then repeats every 30 minutes and whenever the tab regains focus.
2. The backend checks its in-memory cache. If the cache is empty or older than 30 minutes, it calls Apify's `run-sync-get-dataset-items` endpoint for the configured actor (reading `APIFY_TOKEN` from the environment, itself sourced from Secret Manager) and refreshes the cache. Concurrent requests during a refresh await the same in-flight promise instead of triggering duplicate Apify runs.
3. Otherwise it serves the cached JSON straight away — cheap and fast, and keeps Apify usage bounded regardless of visitor traffic.
4. The response is rendered into the "Live wire" panel with a relative "updated Xm ago" timestamp. If the backend is unreachable or `error` is set, the panel falls back to a static message rather than breaking the page.

## Security notes

- CORS on the backend is scoped to `https://nrusimhaviewa-byte.github.io` only — no wildcard, so the endpoint (and the Apify credits behind it) can't be hot-linked from other origins.
- `APIFY_TOKEN` lives only in Secret Manager, mounted at container start; it is never committed to the repo, never embedded in the frontend, and never passed through any AI-agent tool call.
- Cloud Run scales to zero on idle — no baseline compute cost when there's no traffic.

## What's *not* live-refreshed

Stock/ETF/mutual-fund prices, the momentum watchlist, and market commentary are sourced from INDmoney MCP and web research, then written directly into the static HTML by hand (or by a future scheduled Claude run — see the "scheduled regeneration" option considered alongside this backend). Only the news panel is genuinely live in-browser; wiring price data the same way would need either a public market-data API safe to call from a browser, or extending this backend to also proxy INDmoney-derived data.
