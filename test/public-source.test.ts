import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";

test("source installs without paid UI packages or private artifact URLs", async () => {
  const lockText = await readFile("package-lock.json", "utf8");
  const lock = JSON.parse(lockText) as { packages: Record<string, { resolved?: string }> };
  assert.doesNotMatch(lockText, /@heroui-pro|heroui\.pro|heroui-auth/i);
  for (const entry of Object.values(lock.packages)) {
    if (entry.resolved) assert.equal(new URL(entry.resolved).hostname, "registry.npmjs.org");
  }
});

test("UI sources do not import or bundle HeroUI Pro", async () => {
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (/\.(tsx?|css)$/.test(path)) {
        assert.doesNotMatch(await readFile(path, "utf8"), /@heroui-pro\//, path);
      }
    }
  }
  await inspect("ui/src");
});

test("server runtime does not depend on UI build packages", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { dependencies: Record<string, string> };
  for (const name of Object.keys(manifest.dependencies)) {
    assert.doesNotMatch(name, /heroui|react|cmdk|lucide|tailwind|vite/);
  }
});

test("Node requirement matches the browser runtime and local version selector", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  assert.equal(manifest.engines.node, ">=24.0.0");
  assert.equal(lock.packages[""].engines.node, manifest.engines.node);
  assert.equal(lock.packages["node_modules/agent-browser"].engines.node, manifest.engines.node);
  assert.equal((await readFile(".nvmrc", "utf8")).trim(), "24");
  assert.match(await readFile("README.md", "utf8"), /Node\.js 24 or newer/);
});

test("Git ignores local secrets at any depth while allowing scrubbed env examples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browsersilo-ignore-test-"));
  try {
    await copyFile(".gitignore", join(directory, ".gitignore"));
    execFileSync("git", ["init", "--quiet", directory]);
    const secrets = [".env", ".env.local", ".env.production", ".npmrc", ".netrc", "secrets/credentials.json", "private.pem", "private.key", "private.p12", "private.pfx", "id_rsa", "id_ed25519"];
    const expected = secrets.flatMap((path) => [path, `nested/${path}`]);
    const examples = [".env.example", ".env.production.example", "nested/.env.example", "nested/.env.local.example"];
    const ignored = execFileSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--stdin"], {
      cwd: directory,
      input: [...expected, ...examples].join("\n"),
      encoding: "utf8",
    }).trim().split("\n");
    assert.deepEqual(ignored.sort(), expected.sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local env example is safe to copy and only configures supported Compose variables", async () => {
  const example = await readFile(".env.example", "utf8");
  const values = parseEnv(example);
  const compose = await readFile("compose.yaml", "utf8");
  for (const name of Object.keys(values)) {
    assert.ok(compose.includes(`\${${name}`), `${name} must be consumed by Compose`);
  }
  assert.equal(values["BROWSERSILO_BIND_ADDRESS"], "127.0.0.1");
  assert.equal(values["BROWSERSILO_BROWSER_PORT"], "4100");
  assert.equal(values["BROWSERSILO_ADMIN_PORT"], "4101");
  assert.equal(values["BROWSERSILO_ADMIN_TOKEN"], "admin-local-development-token");
  assert.equal(values["BROWSERSILO_AGENT_TOKEN"], "agent-local-development-token");
  assert.equal(values["BROWSERSILO_WORKER_MANAGER_TOKEN"], "local-worker-manager-token-change-me");
  assert.equal(values["BROWSERSILO_DATA_KEY"], "");
  assert.equal(values["BROWSERSILO_PRINCIPALS_JSON"], "");
  assert.equal(values["BROWSERSILO_WARM_SHELLS"], "0");
  assert.doesNotMatch(example, /\/Users\/|\/home\/|\.ts\.net\b|BEGIN .*PRIVATE KEY/);
});
