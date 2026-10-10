import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { load, save } from "./e.mjs";

// Inputs S = {name: [S entries]}: run r.mjs once per name, one after another
// (like the staggered production runs), each in its own folder. Sets listed in
// X also keep their output files.
const { S = {}, X = [] } = await load();
const r = resolve("r.mjs");

async function files(d, p = "") {
  const o = {};
  for (const e of await readdir(join(d, p), { withFileTypes: true }).catch(() => []))
    if (e.isDirectory()) Object.assign(o, await files(d, join(p, e.name)));
    else o[join(p, e.name).replaceAll("\\", "/")] = (await readFile(join(d, p, e.name), "utf8")).slice(0, 500000);
  return o;
}

async function run(n) {
  const cwd = resolve("o", "r", n);
  await mkdir(cwd, { recursive: true });
  const t = Date.now();
  const out = await new Promise((ok) =>
    execFile(process.execPath, [r], { cwd, env: { ...process.env, S: JSON.stringify(S[n]) }, maxBuffer: 1 << 24 }, (e, so, se) =>
      ok({ code: e?.code ?? 0, lines: so.trim().split("\n"), err: se.trim().slice(0, 5000) }),
    ),
  );
  return { n, s: Math.round((Date.now() - t) / 1000), ...out, ...(X.includes(n) && { d: await files(cwd) }) };
}

const R = [];
for (const n of Object.keys(S)) R.push(await run(n));
for (const x of R) {
  const bad = x.lines.filter((l) => / fail/.test(l));
  console.log(`${x.n} ${x.s}s ok=${x.lines.length - bad.length} fail=${bad.length} exit=${x.code}`);
  bad.forEach((l) => console.log(`  ${x.n} ${l}`));
}
await save("s", { at: new Date().toISOString(), r: R });
