import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, save } from "./e.mjs";

// Every input P entry with w: open u in headless Chrome and record every
// request (iframes and workers too) for w seconds. With f, also open up to
// three outage-looking links from the page.
const B = (await load()).P.map((p, i) => ({ ...p, i })).filter((p) => p.w);
const KEEP = new Set(["Document", "XHR", "Fetch"]);
const NOISE =
  /google|gstatic|doubleclick|facebook|arcgis\.com|virtualearth|cloudflareinsights|hotjar|clarity\.ms|newrelic|nr-data|recaptcha|fonts\./;
const LINKS = `JSON.stringify([...document.querySelectorAll("a[href], iframe[src]")]
  .map((a) => [a.href || a.src, (a.textContent || "").trim()])
  .filter(([h, t]) => /^https?:/.test(h) && /outage|power.?out|storm.?cent/i.test(h + " " + t)
    && !/report|facebook|twitter|\\.pdf/i.test(h)))`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9333;
const chrome = spawn(
  process.env.CHROME ?? "google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${await mkdtemp(join(tmpdir(), "b"))}`,
    "--window-size=1366,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ver;
for (let i = 0; i < 100 && !ver; i++)
  ver = await fetch(`http://127.0.0.1:${port}/json/version`)
    .then((r) => r.json())
    .catch(() => sleep(200));
const ua = ver["User-Agent"].replace("HeadlessChrome", "Chrome");

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const wait = new Map();
const subs = new Set();
ws.onmessage = (m) => {
  const x = JSON.parse(m.data);
  if (wait.has(x.id)) {
    wait.get(x.id)(x);
    wait.delete(x.id);
  } else subs.forEach((f) => f(x));
};
// Every call resolves within 30 s, so one stuck page can't hang the run.
const send = (method, params = {}, sessionId) =>
  new Promise((r) => {
    const i = ++n;
    wait.set(i, r);
    setTimeout(() => wait.delete(i) && r({ error: "timeout" }), 30000);
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

async function visit(p) {
  const L = [];
  const at = new Map();
  const ses = new Set();
  const body = [];
  const setup = async (s) => {
    ses.add(s);
    await send("Network.enable", {}, s);
    await send("Page.enable", {}, s);
    await send("Network.setUserAgentOverride", { userAgent: ua, acceptLanguage: "en-US,en" }, s);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s);
    await send("Runtime.runIfWaitingForDebugger", {}, s);
  };
  const f = ({ method: m, params: q, sessionId: s }) => {
    if (!ses.has(s)) return;
    const k = `${s}/${q?.requestId}`;
    if (m === "Target.attachedToTarget") setup(q.sessionId);
    else if (m === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true }, s);
    else if (m === "Network.requestWillBeSent") {
      if (q.redirectResponse && at.has(k)) at.get(k).status = q.redirectResponse.status;
      const r = { u: q.request.url, m: q.request.method, type: q.type };
      if (q.request.postData) r.post = q.request.postData.slice(0, 5000);
      at.set(k, r);
      L.push(r);
    } else if (m === "Network.responseReceived" && at.has(k)) {
      const r = at.get(k);
      Object.assign(r, { status: q.response.status, mime: q.response.mimeType });
      if (KEEP.has(r.type)) r.headers = q.response.headers;
    } else if (m === "Network.loadingFinished" && at.has(k)) {
      const r = at.get(k);
      r.bytes = q.encodedDataLength;
      if (KEEP.has(r.type) && !NOISE.test(URL.parse(r.u)?.host ?? ""))
        body.push(
          send("Network.getResponseBody", { requestId: q.requestId }, s).then((x) => {
            if (x.result) r.body = x.result.body.slice(0, 200000);
            if (x.result?.base64Encoded) r.b64 = true;
          }),
        );
    } else if (m === "Network.loadingFailed" && at.has(k))
      at.get(k).error = q.errorText;
  };
  subs.add(f);
  const { result: t } = await send("Target.createTarget", { url: "about:blank" });
  const { result: a } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  await setup(a.sessionId);
  send("Page.navigate", { url: p.u }, a.sessionId);
  await sleep((p.w ?? 25) * 1000);
  const ev = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true }, a.sessionId)).result?.result?.value;
  const [href, html] = JSON.parse((await ev("JSON.stringify([location.href, document.documentElement.outerHTML])")) ?? "[]");
  const links = p.f ? JSON.parse((await ev(LINKS)) ?? "[]") : undefined;
  await Promise.all(body);
  subs.delete(f);
  await send("Target.closeTarget", { targetId: t.targetId });
  return { href, html: html?.slice(0, 300000), links, L };
}

async function page(p) {
  const r = await visit(p).catch((e) => ({ L: [], error: String(e) }));
  const go = [...new Set((r.links ?? []).map((l) => l[0]))].filter((u) => u !== p.u && u !== r.href).slice(0, 3);
  r.next = [];
  for (const u of go) r.next.push({ u, ...(await visit({ u, w: 20 }).catch((e) => ({ L: [], error: String(e) }))) });
  return r;
}

const sum = (r) => {
  const c = (f) => r.L.filter(f).length;
  const s = r.L[0]?.status ?? r.L[0]?.error ?? r.error ?? "-";
  return (
    `doc=${s} req=${r.L.length} xhr=${c((x) => x.type === "XHR" || x.type === "Fetch")} ` +
    `4xx=${c((x) => x.status >= 400 && x.status < 500)} 5xx=${c((x) => x.status >= 500)} fail=${c((x) => x.error)}`
  );
};

const R = new Array(B.length);
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < B.length) {
      const j = next++;
      R[j] = await page(B[j]);
    }
  }),
);
R.forEach((r, j) => {
  console.log(`${B[j].i} ${sum(r)}`);
  r.next.forEach((x, k) => console.log(`${B[j].i}.${k + 1} ${sum(x)}`));
});
await save("b", { at: new Date().toISOString(), r: R.map((r, j) => ({ ...B[j], ...r })) });
ws.close();
chrome.kill();
