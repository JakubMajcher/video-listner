// SPDX-FileCopyrightText: 2026 Jakub Majcher
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Bumps the version in manifest.json and package.json together.
 *
 *   npm run bump -- 1.0.1
 *
 * addons.mozilla.org never accepts the same version number twice, not even after a
 * rejected submission, so this refuses anything that is not strictly higher than the
 * current one. The version line is rewritten in place to keep both files formatted
 * exactly as they were.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const FILES = ["manifest.json", "package.json"];
const SEMVER = /^\d+\.\d+\.\d+$/;

const readVersion = (file) => {
  const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
  const match = raw.match(/"version"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error(`no version field in ${file}`);
  return { raw, current: match[1] };
};

const isHigher = (next, current) => {
  const a = next.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
};

const [next] = process.argv.slice(2);

if (!SEMVER.test(next ?? "")) {
  console.error("usage: npm run bump -- 1.0.1");
  process.exit(2);
}

const versions = FILES.map((file) => ({ file, ...readVersion(file) }));
const [{ current }] = versions;

// Comparing against the manifest alone let a drifted package.json be written backwards.
const drifted = versions.filter((entry) => entry.current !== current);
if (drifted.length) {
  console.error(
    `versions disagree before bumping: ${versions.map((e) => `${e.file}=${e.current}`).join(", ")}`,
  );
  process.exit(1);
}

if (!isHigher(next, current)) {
  console.error(`refusing to go from ${current} to ${next}: AMO rejects reused version numbers`);
  process.exit(1);
}

for (const { file, raw } of versions) {
  fs.writeFileSync(
    path.join(ROOT, file),
    raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`),
  );
  console.log(`  ${file}: ${current} -> ${next}`);
}

console.log(`\nNext: update CHANGELOG.md, run npm test && npm run build, then upload to AMO.`);
