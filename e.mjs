import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const key = () => Buffer.from(process.env.K ?? "", "hex");
const open = (b) => {
  const c = createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
  c.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([c.update(b.subarray(28)), c.final()]);
};

// Plain JSON locally, encrypted in CI (the repo is public), nothing without K.
export async function save(name, o) {
  const out = Buffer.from(JSON.stringify(o, null, 1));
  await mkdir("o", { recursive: true });
  if (!process.env.CI) return writeFile(`o/${name}.json`, out);
  if (key().length !== 32) return;
  const v = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), v);
  const x = Buffer.concat([c.update(out), c.final()]);
  await writeFile(`o/${name}.enc`, Buffer.concat([v, c.getAuthTag(), x]));
}

if (process.argv[1]?.endsWith("e.mjs"))
  process.stdout.write(open(await readFile(process.argv[2])));
