import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const key = () => Buffer.from(process.env.K ?? "", "hex");
export const seal = (b) => {
  const v = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), v);
  const x = Buffer.concat([c.update(b), c.final()]);
  return Buffer.concat([v, c.getAuthTag(), x]);
};
export const open = (b) => {
  const c = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  c.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([c.update(b.subarray(28)), c.final()]);
};

// Inputs: plain i.json locally, the committed i.enc in CI (the repo is public).
export const load = async () =>
  JSON.parse(
    process.env.CI ? open(await readFile("i.enc")) : await readFile("i.json"),
  );

// Results: plain JSON locally, encrypted in CI, nothing without K.
export async function save(name, o) {
  const out = Buffer.from(JSON.stringify(o, null, 1));
  await mkdir("o", { recursive: true });
  if (!process.env.CI) return writeFile(`o/${name}.json`, out);
  if (key().length === 32) await writeFile(`o/${name}.enc`, seal(out));
}

if (process.argv[1]?.endsWith("e.mjs"))
  process.stdout.write(open(await readFile(process.argv[2])));
