# crash-pastebin

Drop a Windows `.dmp` file in your browser, see the crash. Optionally upload to get a shareable URL.

**Live:** https://crash-pastebin.audowty.workers.dev

## Architecture

```
┌─ public/ ─ static frontend (HTML/CSS/JS + WASM minidump parser)
│
├─ wasm/   ─ Rust crate, hand-rolled minidump reader, compiled to WASM
│           │  Mozilla's `minidump` crate doesn't WASM-build cleanly, so
│           │  the parser is bespoke: ~400 LOC, covers Header + StreamDirectory
│           │  + ExceptionStream + ModuleList + ThreadList + SystemInfo + MiscInfo.
│           │  Extracts exception name, address, x64 register context, modules,
│           │  threads, OS / CPU info.
│
├─ worker/ ─ Cloudflare Worker (TypeScript + Hono)
│           │  POST /api/upload   → SHA-256 the file, store in R2, return short id
│           │  GET  /api/dump/:id → fetch from R2, stream back
│           │  GET  /*            → ASSETS.fetch (serves the static frontend)
│
└─ wrangler.toml ─ R2 binding, assets binding, rate-limiter binding
```

Parsing happens entirely client-side; the Worker only stores raw bytes (keyed by content hash, deduped) and serves them back. The URL fragment is the first 16 hex chars of the file's SHA-256.

## Cost model — designed to stay free

This deploys on Cloudflare's free tier. Hard limits keep costs at $0:

| Layer | Limit | Mitigation |
|---|---|---|
| **Per-upload size** | 5MB | enforced in `worker/index.ts` |
| **Per-IP upload rate** | 5/min | Workers Rate Limiting binding |
| **Bucket total size** | 4GB | checked before each upload — refuses when full |
| **Dump retention** | 7 days | R2 lifecycle rule, set via one-shot command below |
| **Workers requests** | 100k/day | CF free-tier hard cap — returns 429 past that, never charged |
| **R2 storage** | 10GB free | bucket size guard above keeps us under |

**Set the R2 lifecycle rule once** (auto-delete after 7 days):
```
npx wrangler r2 bucket lifecycle add crash-pastebin --id auto-expire --prefix dumps/ --expire-age-seconds 604800
```

**Set a billing alert** at https://dash.cloudflare.com/?to=/:account/billing/notifications — pick any low amount (e.g. $1) so you get an email if anything ever does go over.

## Develop

```
npm install
npx wrangler login
npx wrangler r2 bucket create crash-pastebin
npm run dev
```

## Test the parser headless

```
npm run test:parser path/to/some.dmp
```

## Deploy

```
npm run deploy
```

## License

MIT.
