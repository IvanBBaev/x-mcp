// Claude Desktop bundle builder (`.mcpb`, docs/08 Phase 4). Same house style as the other
// scripts: Node stdlib only, `process.stdout.write` for output, a non-zero exit on failure.
//
//   npm run bundle                       clean build + manifest guard + this script
//   node scripts/bundle.mjs [--out <file.mcpb>]
//
// An MCPB bundle is a zip archive with `manifest.json` at its root plus everything the server
// needs to run without an install step (MANIFEST.md, "Node.js: all dependencies must be
// bundled in node_modules"). The archive holds:
//
//   manifest.json, package.json, LICENSE, README.md   metadata (`package.json` carries
//                                                     `"type": "module"`, which Node needs to
//                                                     load the ESM build)
//   bin/x-mcp-ai.cjs                                  the entry point (Node-version guard)
//   build/src/**/*.{js,json}                          the compiled server, no tests, no maps
//   node_modules/<production closure>                 exactly the non-dev packages of
//                                                     package-lock.json, minus the files
//                                                     `mcpb pack` excludes by default (maps,
//                                                     type declarations, tool configs)
//
// WHY NOT `mcpb pack`. The official CLI stamps every entry with the current time
// (`zipSync(files, { mtime: new Date() })`), so two packs of the same tree differ byte for
// byte. This script writes the zip itself: entries sorted by path, every timestamp fixed at
// the DOS epoch (1980-01-01 00:00), fixed modes, deflate at a fixed level. The same commit
// with the same `npm ci` tree yields the same bytes and the same SHA-256 (given the same
// checked-out bytes — a Windows checkout with CRLF conversion bundles different text files).
//
// WHY THE LOCKFILE, NOT `npm ls`. The production closure is read from package-lock.json
// (every `packages` entry without `"dev": true`), and every installed copy is checked against
// the version the lockfile pins — a stale `node_modules` fails the build instead of shipping
// whatever happens to be on disk. No `npm` subprocess, so it behaves the same on Windows.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const METADATA_FILES = ['manifest.json', 'package.json', 'LICENSE', 'README.md'];
const ENTRY_POINT = 'bin/x-mcp-ai.cjs';
const BUILD_DIR = 'build/src';
const BUILD_EXTENSIONS = new Set(['.js', '.json']);

/**
 * Files dropped from the dependency closure: the `mcpb pack` default exclusions that can occur
 * inside a published package (source maps, type declarations, tool configs, logs, env files),
 * matched on the basename. None of them is loaded at run time.
 */
const DEPENDENCY_EXCLUDES = [
  /\.map$/,
  /\.d\.[cm]?ts$/,
  /\.tsbuildinfo$/,
  /\.log$/,
  /^\.env/,
  /^tsconfig\.json$/,
  /^\.(?:DS_Store|gitignore|npmignore|npmrc|yarnrc|editorconfig|eslintrc|eslintignore|prettierrc|prettierignore|nycrc|babelrc)$/,
  /^Thumbs\.db$/,
];
const keepDependencyFile = (file) => {
  const base = path.basename(file);
  return !DEPENDENCY_EXCLUDES.some((pattern) => pattern.test(base));
};

/** DOS date for 1980-01-01 (year offset 0, month 1, day 1); time 00:00:00. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const MODE_FILE = 0o100644;
const MODE_EXEC = 0o100755;
const ZIP_UTF8_FLAG = 0x0800;
const DEFLATE_LEVEL = 9;

function fail(message) {
  process.stderr.write(`bundle: FAIL — ${message}\n`);
  process.exit(1);
}

function toZipPath(relative) {
  return relative.split(path.sep).join('/');
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

/** Every regular file under `dir` (repo-relative), skipping `skipDirs` names; symlinks fail. */
function walk(relativeDir, { skipDirs = new Set(), filter = () => true } = {}) {
  const out = [];
  const visit = (relative) => {
    for (const dirent of fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
      const child = path.join(relative, dirent.name);
      if (dirent.isSymbolicLink()) fail(`refusing to bundle a symlink: ${toZipPath(child)}`);
      if (dirent.isDirectory()) {
        if (!skipDirs.has(dirent.name)) visit(child);
      } else if (dirent.isFile() && filter(child)) {
        out.push(child);
      }
    }
  };
  visit(relativeDir);
  return out;
}

/** The repo-relative directories of every production package the lockfile pins. */
function productionPackages(lock) {
  if (lock.lockfileVersion !== 3 && lock.lockfileVersion !== 2) {
    fail(`package-lock.json lockfileVersion ${lock.lockfileVersion} has no "packages" map`);
  }
  const dirs = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '' || entry.dev === true) continue;
    if (entry.link === true) fail(`linked package ${key} cannot be bundled`);
    const dir = key.split('/').join(path.sep);
    const manifestPath = path.join(ROOT, dir, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      // Platform-specific optional packages are pinned for every OS but installed on one.
      if (entry.optional === true || entry.devOptional === true) continue;
      fail(`${key} is a production dependency but is not installed — run \`npm ci\``);
    }
    const installed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
    if (installed !== entry.version) {
      fail(
        `${key} is ${installed} on disk, package-lock.json pins ${entry.version} — run \`npm ci\``,
      );
    }
    dirs.push(dir);
  }
  return dirs;
}

function collectFiles() {
  const lock = readJson('package-lock.json');
  const files = new Set();
  for (const file of METADATA_FILES) {
    if (!fs.existsSync(path.join(ROOT, file))) fail(`missing ${file}`);
    files.add(file);
  }
  if (!fs.existsSync(path.join(ROOT, ENTRY_POINT))) fail(`missing ${ENTRY_POINT}`);
  files.add(ENTRY_POINT);

  if (!fs.existsSync(path.join(ROOT, BUILD_DIR, 'index.js'))) {
    fail(`${BUILD_DIR}/index.js not found — run \`npm run build\` first`);
  }
  for (const file of walk(BUILD_DIR, {
    filter: (f) => BUILD_EXTENSIONS.has(path.extname(f)),
  })) {
    files.add(file);
  }

  // A package's own nested node_modules are separate lockfile entries, judged on their own.
  for (const dir of productionPackages(lock)) {
    for (const file of walk(dir, {
      skipDirs: new Set(['node_modules', '.bin', '.cache']),
      filter: keepDependencyFile,
    })) {
      files.add(file);
    }
  }
  return [...files].map(toZipPath).sort();
}

// --- Deterministic zip writer ----------------------------------------------------------------

function zip(entries) {
  if (entries.length > 0xffff) fail(`${entries.length} entries need ZIP64, which is not written`);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data, mode } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: DEFLATE_LEVEL });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = zlib.crc32(data);
    if (offset > 0xffffffff || body.length > 0xffffffff) fail('archive needs ZIP64');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, spec 2.0 — keeps the mode bits
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

// --- Main ------------------------------------------------------------------------------------

function main() {
  const manifest = readJson('manifest.json');
  const outFlag = process.argv.indexOf('--out');
  const out =
    outFlag > 0 && process.argv[outFlag + 1] !== undefined
      ? path.resolve(process.argv[outFlag + 1])
      : path.join(ROOT, 'build', 'mcpb', `${manifest.name}-${manifest.version}.mcpb`);

  const entries = collectFiles().map((name) => ({
    name,
    data: fs.readFileSync(path.join(ROOT, ...name.split('/'))),
    mode: name === ENTRY_POINT ? MODE_EXEC : MODE_FILE,
  }));
  const archive = zip(entries);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, archive);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const modules = new Set(
    entries.map((e) => /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(e.name)?.[1]).filter(Boolean),
  );
  process.stdout.write(
    `bundle: wrote ${path.relative(process.cwd(), out) || out} — ${entries.length} files, ` +
      `${modules.size} top-level package(s), ${(archive.length / 1024).toFixed(1)} KiB\n` +
      `bundle: sha256 ${sha256}\n`,
  );
}

main();
