// Single-line JSON stderr log formatting (CFG-5; docs/07-corner-cases.md CFG-5). `core` does
// no I/O and imports nothing from other layers; this module is dependency-free — the caller
// supplies `ts` rather than this module reading the system clock, the same convention
// `core/timebounds.ts` uses for `now`, so formatting stays deterministic under test.
//
// Scope: this is the format for the startup/runtime notices the server already prints today
// (CFG-6, CFG-8, CFG-9, AUTH-5, AUTH-12, PLAT-2 — see docs/07-corner-cases.md). It is NOT the
// full observability layer docs/04-security.md §6 describes (X_MCP_LOG_LEVEL-gated verbosity,
// request logging, redaction) — that remains unimplemented; nothing here should be read as
// delivering it. The CFG-5 fatal-startup line stays plain text and does not go through this
// module.

/** Severity of a single log line. Only `warn` is emitted today; `error` is reserved. */
export type LogLevel = 'warn' | 'error';

/**
 * Render one single-line JSON log record for stderr (CFG-5): `{"ts", "level", "msg"}`, in
 * that key order, nothing else, and no trailing newline (the caller appends one).
 */
export function formatLogLine(level: LogLevel, msg: string, ts: string): string {
  return JSON.stringify({ ts, level, msg });
}
