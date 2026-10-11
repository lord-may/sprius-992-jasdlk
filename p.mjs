import { lookup } from "node:dns/promises";
import { load, save } from "./e.mjs";

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
      body: b.slice(0, 500000),
    });
  } catch (e) {
    Object.assign(r, { status: "fail", ms: Date.now() - t, error: why(e) });
  }
  return r;
}

const { P } = await load();
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

// 8 at a time: 142 at once starved DNS (libuv's 4 threads) and every probe
// hit the 10 s connect timeout, even ones that always answer.
const R = new Array(P.length);
let next = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next < P.length) {
      const j = next++;
      R[j] = await probe(P[j]);
    }
  }),
);
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

await save("p", {
  at: new Date().toISOString(),
  runner: me,
  r: R.map((r, i) => ({ ...P[i], ...r })),
});
