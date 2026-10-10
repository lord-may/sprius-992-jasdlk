import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { save } from "./e.mjs";

// Env B = JSON array of {u, w?}: open u in headless Chrome, record every
// request (iframes and workers too) for w seconds (default 25).
const B = JSON.parse(process.env.B ?? "[]");
const KEEP = new Set(["Document", "XHR", "Fetch"]);
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
const send = (method, params = {}, sessionId) =>
  new Promise((r) => {
    wait.set(++n, r);
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });

async function load(p) {
  const L = [];
  const at = new Map();
  const ses = new Set();
  const body = [];
  const setup = async (s) => {
    ses.add(s);
    await send("Network.enable", {}, s);
    await send("Network.setUserAgentOverride", { userAgent: ua, acceptLanguage: "en-US,en" }, s);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s);
    await send("Runtime.runIfWaitingForDebugger", {}, s);
  };
  const f = ({ method: m, params: q, sessionId: s }) => {
    if (!ses.has(s)) return;
    const k = `${s}/${q?.requestId}`;
    if (m === "Target.attachedToTarget") setup(q.sessionId);
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
      if (KEEP.has(r.type))
        body.push(
          send("Network.getResponseBody", { requestId: q.requestId }, s).then((x) => {
            if (x.result) r.body = x.result.body.slice(0, 300000);
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
  await send("Page.navigate", { url: p.u }, a.sessionId);
  await sleep((p.w ?? 25) * 1000);
  const { result: d } = await send(
    "Runtime.evaluate",
    { expression: "JSON.stringify([location.href, document.documentElement.outerHTML])", returnByValue: true },
    a.sessionId,
  );
  await Promise.all(body);
  subs.delete(f);
  await send("Target.closeTarget", { targetId: t.targetId });
  const [href, html] = d?.result?.value ? JSON.parse(d.result.value) : [];
  return { href, html: html?.slice(0, 500000), L };
}

const R = [];
for (let i = 0; i < B.length; i += 4)
  R.push(...(await Promise.all(B.slice(i, i + 4).map(load))));
R.forEach((r, i) => {
  const c = (f) => r.L.filter(f).length;
  const s = r.L[0]?.status ?? r.L[0]?.error ?? "-";
  console.log(
    `${i} doc=${s} req=${r.L.length} xhr=${c((x) => x.type === "XHR" || x.type === "Fetch")} ` +
      `4xx=${c((x) => x.status >= 400 && x.status < 500)} 5xx=${c((x) => x.status >= 500)} ` +
      `fail=${c((x) => x.error)} hosts=${new Set(r.L.map((x) => URL.parse(x.u)?.host)).size}`,
  );
});
await save("b", { at: new Date().toISOString(), r: R.map((r, i) => ({ ...B[i], ...r })) });
ws.close();
chrome.kill();
