# crash-pastebin

Drop a Windows `.dmp` file in your browser, see the crash details instantly. Optionally upload for a shareable URL.

Parsing happens entirely client-side via a hand-rolled Rust/WASM minidump reader (~400 LOC). Nothing leaves your machine unless you choose to share it.

**Live:** https://crash-pastebin.audowty.workers.dev

## Develop

```
npm install
npx wrangler login
npx wrangler r2 bucket create crash-pastebin
npm run dev
```

## Deploy

```
npm run deploy
```

Runs on Cloudflare's free tier. Uploads are stored in R2, keyed by content hash, auto-expired after 7 days.

## License

MIT
