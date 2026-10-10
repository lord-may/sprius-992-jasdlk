import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const H = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
};
const W =
  /captcha|incapsula|access denied|request is blocked|could not be satisfied|attention required|just a moment|site blocked|forbidden|not available in your/;

const key = () => Buffer.from(process.env.K ?? "", "hex");
const seal = (b) => {
  const v = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), v);
  const x = Buffer.concat([c.update(b), c.final()]);
  return Buffer.concat([v, c.getAuthTag(), x]);
};
const open = (b) => {
  const c = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  c.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([c.update(b.subarray(28)), c.final()]);
};

if (process.argv[2] === "d") {
  process.stdout.write(open(await readFile(process.argv[3])));
  process.exit();
}

const why = (e) => {
  const c = e?.cause?.code ?? e?.code ?? "";
  return `${e?.name ?? ""} ${c}`.trim();
};
const kind = (t, c) => {
  const s = t.trimStart().slice(0, 200).toLowerCase();
  try {
    JSON.parse(t);
    return "json";
  } catch {}
  if (/^<!doctype html|^<html|<head|<body/.test(s)) return "html";
  if (/^<\?xml|^</.test(s)) return "xml";
  return /javascript/.test(c) ? "js" : t ? "text" : "empty";
};

async function probe(p) {
  const r = { dns: "ok" };
  try {
    await lookup(new URL(p.u).hostname);
  } catch (e) {
    r.dns = why(e);
  }
  const t = Date.now();
  try {
    const x = await fetch(p.u, {
      method: p.m ?? "GET",
      headers: {
        ...H,
        ...p.h,
        ...(p.b && { "content-type": "application/json; charset=utf-8" }),
      },
      body: p.b ? JSON.stringify(p.b) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const b = await x.text();
    const c = x.headers.get("content-type") ?? "";
    Object.assign(r, {
      status: x.status,
      ms: Date.now() - t,
      bytes: b.length,
      type: c.split(";")[0],
      server: x.headers.get("server") ?? "",
      redirected: x.redirected,
      kind: kind(b, c),
      hint: W.exec(b.slice(0, 20000).toLowerCase())?.[0] ?? "",
      final: x.url,
      headers: Object.fromEntries(x.headers),
      body: b.slice(0, 4000),
    });
  } catch (e) {
    Object.assign(r, { status: "fail", ms: Date.now() - t, error: why(e) });
  }
  return r;
}

const P = JSON.parse(process.env.P ?? "[]");
let me = {};
try {
  const j = await (
    await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(10000) })
  ).json();
  me = { country: j.country, region: j.region, org: j.org };
} catch (e) {
  me = { error: why(e) };
}
console.log(`runner ${JSON.stringify(me)}`);

const R = await Promise.all(P.map(probe));
R.forEach((r, i) =>
  console.log(
    [
      `${i}`,
      r.status,
      `${r.ms}ms`,
      r.error ?? `${r.bytes}B ${r.kind} ${r.type || "-"}`,
      r.server && `server=${r.server}`,
      r.redirected && "redirected",
      r.hint && `hint="${r.hint}"`,
      r.dns !== "ok" && `dns=${r.dns}`,
    ]
      .filter(Boolean)
      .join(" "),
  ),
);

const out = JSON.stringify(
  { at: new Date().toISOString(), runner: me, r: R.map((r, i) => ({ ...P[i], ...r })) },
  null,
  1,
);
await mkdir("o", { recursive: true });
if (!process.env.CI) await writeFile("o/p.json", out);
else if (key().length === 32) await writeFile("o/p.enc", seal(Buffer.from(out)));
