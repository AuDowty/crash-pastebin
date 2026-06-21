import { Hono } from "hono";

interface RateLimit {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ASSETS: Fetcher;
  DUMPS: R2Bucket;
  UPLOAD_RATE_LIMITER: RateLimit;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_BUCKET_SIZE = 4 * 1024 * 1024 * 1024;
const MDMP_SIGNATURE = 0x504d444d;

const app = new Hono<{ Bindings: Env }>();

app.post("/api/upload", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "anonymous";
  const { success } = await c.env.UPLOAD_RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json({ error: "rate limit exceeded — try again in a minute" }, 429);
  }

  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_FILE_SIZE) {
    return c.json(
      { error: `file too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` },
      413,
    );
  }
  if (body.byteLength < 32) {
    return c.json({ error: "too small to be a minidump" }, 400);
  }
  const view = new DataView(body);
  if (view.getUint32(0, true) !== MDMP_SIGNATURE) {
    return c.json({ error: "not a minidump (missing MDMP signature)" }, 400);
  }

  const used = await currentBucketSize(c.env.DUMPS);
  if (used + body.byteLength > MAX_BUCKET_SIZE) {
    return c.json(
      {
        error:
          "shared storage is full — try again later (uploads auto-expire after 7 days)",
      },
      507,
    );
  }

  const hashBuf = await crypto.subtle.digest("SHA-256", body);
  const fullHash = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const shortId = fullHash.slice(0, 16);
  const key = `dumps/${fullHash}.dmp`;

  const existing = await c.env.DUMPS.head(key);
  if (!existing) {
    await c.env.DUMPS.put(key, body, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { uploadedAt: new Date().toISOString() },
    });
  }

  return c.json({ id: shortId, hash: fullHash, url: `/?h=${shortId}` });
});

app.get("/api/dump/:id", async (c) => {
  const id = c.req.param("id").toLowerCase();
  if (!/^[a-f0-9]{16,64}$/.test(id)) {
    return c.json({ error: "invalid id" }, 400);
  }
  const list = await c.env.DUMPS.list({ prefix: `dumps/${id}`, limit: 2 });
  if (list.objects.length === 0) {
    return c.json({ error: "not found (may have expired — dumps auto-delete after 7 days)" }, 404);
  }
  if (list.objects.length > 1) {
    return c.json({ error: "ambiguous id" }, 400);
  }
  const file = await c.env.DUMPS.get(list.objects[0].key);
  if (!file) return c.json({ error: "not found" }, 404);
  return new Response(file.body as ReadableStream, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

async function currentBucketSize(bucket: R2Bucket): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await bucket.list({ prefix: "dumps/", limit: 1000, cursor });
    for (const obj of page.objects) {
      total += obj.size ?? 0;
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return total;
}

export default app;
