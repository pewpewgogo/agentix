// One-time, LOCAL bootstrap for npm trusted publishing.
//
// npm cannot attach a trusted publisher to a package that has never been
// published, so the five @agentixdev/* names must exist once before the OIDC
// release workflow can publish them. This script publishes a minimal
// placeholder version for each name FROM YOUR LOCAL npm login session
// (browser + 2FA) — no automation token is created at any point.
//
// The placeholders:
//   - version 0.0.0-bootstrap.0 under the dist-tag "bootstrap" (never
//     "latest", so `npm install @agentixdev/core` fails until a real release);
//   - contain only a package.json and a README pointing at the repository;
//   - are deprecated immediately with a pointer to the first real release.
//
// Usage:
//   npm login          # as an owner of the @agentixdev scope
//   node scripts/bootstrap-npm-packages.mjs [--dry-run]
//
// Afterwards configure each package's trusted publisher on npmjs.com
// (see docs/RELEASING.md) and delete nothing: there is no token to revoke.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGES = [
  "@agentixdev/core",
  "@agentixdev/compiler",
  "@agentixdev/cli",
  "@agentixdev/testing",
  "@agentixdev/adapters-http",
];
const VERSION = "0.0.0-bootstrap.0";
const DEPRECATION =
  "Bootstrap placeholder that only reserves the name for npm trusted " +
  "publishing; install a real release (>=0.2.0).";

const dryRun = process.argv.includes("--dry-run");

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const wasDuplicatePublishRejection = () => {
  try {
    const logsDir = join(homedir(), ".npm", "_logs");
    const newest = readdirSync(logsDir).sort().at(-1);
    if (newest === undefined) return false;
    const text = readFileSync(join(logsDir, newest), "utf8");
    return /previously published|cannot publish over|EPUBLISHCONFLICT/i.test(text);
  } catch {
    return false;
  }
};

// A freshly published package is not immediately visible to the registry's
// write-lookup (eventual consistency), so deprecation retries with backoff
// and NEVER aborts the bootstrap: an undeprecated placeholder is cosmetic,
// a missing package name is not.
const deprecateWithRetry = async (name) => {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      npm(["deprecate", `${name}@${VERSION}`, DEPRECATION]);
      console.log(`deprecated: ${name}@${VERSION}`);
      return;
    } catch {
      if (attempt < 6) {
        console.log(`  deprecate not yet possible (registry lag), retry ${attempt}/5 in 10s...`);
        await sleep(10_000);
      }
    }
  }
  console.warn(
    `WARN: could not deprecate ${name}@${VERSION}; run later:\n` +
      `  npm deprecate ${name}@${VERSION} "${DEPRECATION}"`,
  );
};

const npm = (args, options = {}) => {
  const output = execFileSync("npm", args, { encoding: "utf8", stdio: "pipe", ...options });
  return typeof output === "string" ? output.trim() : "";
};

let user;
try {
  user = npm(["whoami"]);
} catch {
  console.error("Not logged in. Run `npm login` (browser + 2FA) first.");
  process.exit(1);
}
console.log(`Publishing bootstrap placeholders as npm user: ${user}`);

for (const name of PACKAGES) {
  let exists = false;
  try {
    npm(["view", name, "name"]);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    console.log(`skip: ${name} already exists on the registry`);
    continue;
  }

  const dir = mkdtempSync(join(tmpdir(), "agentix-bootstrap-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(
        {
          name,
          version: VERSION,
          description: DEPRECATION,
          license: "MIT",
          repository: {
            type: "git",
            url: "git+https://github.com/pewpewgogo/agentix.git",
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(dir, "README.md"),
      `# ${name}\n\n${DEPRECATION}\nSee https://github.com/pewpewgogo/agentix.\n`,
    );
    const publishArgs = [
      "publish",
      "--access",
      "public",
      "--tag",
      "bootstrap",
      ...(dryRun ? ["--dry-run"] : []),
    ];
    console.log(`publish: ${name}@${VERSION}${dryRun ? " (dry run)" : ""}`);
    try {
      npm(publishArgs, { cwd: dir, stdio: "inherit" });
    } catch (error) {
      // The exists-check can miss a just-published package during registry
      // read-path propagation; a duplicate-version rejection means it is
      // already there. With stdio "inherit" the error object carries no
      // stderr, so consult npm's newest debug log for the rejection text.
      if (wasDuplicatePublishRejection()) {
        console.log(`already published (propagation lag): ${name}@${VERSION}`);
      } else {
        throw error;
      }
    }
    if (!dryRun) await deprecateWithRetry(name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(
  dryRun
    ? "Dry run complete."
    : "Bootstrap complete. Now configure each package's trusted publisher " +
      "on npmjs.com per docs/RELEASING.md, then merge the release pull request.",
);
