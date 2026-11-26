// File-backed LedgerStore — the persistence half of the Q15 spend ledger (core/ledger,
// docs/07 §21 LEDGER-*). An append-only JSONL file, one `{"t":<epoch ms>,"u":<usd>}` per line.
//
// Why append-only: every process that shares the file only ever ADDS lines, opened with
// `O_APPEND`, so the kernel places each small write at the current end — two processes never
// overwrite each other's entries and no read-modify-write cycle exists to lose an update
// (LEDGER-5). A reader keeps a byte offset and folds only the complete lines past it.
//
// Synchronous on purpose: core/ledger's `reserve` must fold, check and append in ONE
// synchronous step (CONC-2). The lines are tiny (~35 B), so a sync append costs about as much
// as the stat that precedes it.
//
// Robustness (LEDGER-6):
//   • A trailing line without its newline (a writer caught mid-write) is not consumed: the
//     offset stops at the last newline, and the line is read once it is complete.
//   • A malformed line is skipped, never guessed at.
//   • A file that shrank, was replaced (new inode) or was removed resets the fold, so an
//     operator who rotates or deletes the ledger starts from the new file's contents.
//   • The file is created 0600 in a 0700 directory and never opened through a symlink
//     (`O_NOFOLLOW`, where the platform has it).
// Errors propagate with their `code`; core/ledger turns them into refusals (hard mode) or
// warnings (warn mode) and never shows the path to the model.

import {
  closeSync,
  constants as FSC,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { LedgerEntry, LedgerRead, LedgerStore } from '../core/ledger.js';

/** The filesystem calls the store makes — injectable so tests can simulate failures. */
export interface LedgerFs {
  statSync(path: string): { size: number; ino: number; dev: number };
  openSync(path: string, flags: number, mode?: number): number;
  fstatSync(fd: number): { size: number };
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  writeSync(fd: number, data: string): number;
  closeSync(fd: number): void;
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
}

const nodeFs: LedgerFs = {
  statSync: (p) => statSync(p),
  openSync: (p, flags, mode) => openSync(p, flags, mode),
  fstatSync: (fd) => fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) =>
    readSync(fd, buffer, offset, length, position),
  writeSync: (fd, data) => writeSync(fd, data),
  closeSync: (fd) => closeSync(fd),
  mkdirSync: (p, options) => mkdirSync(p, options),
};

/** `O_NOFOLLOW` is POSIX-only; on win32 the flag is absent and degrades to 0. */
const NOFOLLOW = (FSC as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** Parse one line; `undefined` for anything that is not a well-formed entry. */
export function parseLedgerLine(line: string): LedgerEntry | undefined {
  if (line.trim() === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { t, u } = value as { t?: unknown; u?: unknown };
  if (
    typeof t !== 'number' ||
    !Number.isFinite(t) ||
    typeof u !== 'number' ||
    !Number.isFinite(u)
  ) {
    return undefined;
  }
  return { at: t, usd: u };
}

export function createFileLedgerStore(path: string, fs: LedgerFs = nodeFs): LedgerStore {
  let offset = 0;
  let identity: { ino: number; dev: number } | undefined;
  let dirReady = false;

  return {
    readNew(): LedgerRead {
      let stat: { size: number; ino: number; dev: number };
      try {
        stat = fs.statSync(path);
      } catch (err) {
        if (!isEnoent(err)) throw err;
        // No file (yet, or any more). Removal after a read resets the fold.
        const reset = identity !== undefined;
        identity = undefined;
        offset = 0;
        return { reset, entries: [] };
      }
      let reset = false;
      if (
        identity !== undefined &&
        (identity.ino !== stat.ino || identity.dev !== stat.dev || stat.size < offset)
      ) {
        reset = true;
        offset = 0;
      }
      identity = { ino: stat.ino, dev: stat.dev };
      if (stat.size <= offset) return { reset, entries: [] };

      const fd = fs.openSync(path, FSC.O_RDONLY | NOFOLLOW);
      let text: string;
      try {
        // Re-measure through the descriptor: a writer may have appended since the stat.
        const size = fs.fstatSync(fd).size;
        const length = Math.max(0, size - offset);
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const n = fs.readSync(fd, buffer, read, length - read, offset + read);
          if (n <= 0) break;
          read += n;
        }
        text = buffer.subarray(0, read).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      const end = text.lastIndexOf('\n');
      if (end < 0) return { reset, entries: [] };
      const complete = text.slice(0, end + 1);
      offset += Buffer.byteLength(complete, 'utf8');
      const entries: LedgerEntry[] = [];
      for (const line of complete.split('\n')) {
        const entry = parseLedgerLine(line);
        if (entry !== undefined) entries.push(entry);
      }
      return { reset, entries };
    },
    append(entry: LedgerEntry): void {
      if (!dirReady) {
        fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        dirReady = true;
      }
      const fd = fs.openSync(path, FSC.O_WRONLY | FSC.O_APPEND | FSC.O_CREAT | NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify({ t: entry.at, u: entry.usd })}\n`);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}
