// Subcommand router — a scaffold seam created by T-101.
//
// `authorize` is implemented by cli/authorize.ts (T-204), `doctor` by cli/doctor.ts
// (T-205); the default `serve` path is wired by the composition root (T-130). This
// stub only classifies argv so the entry point compiles and routes deterministically.

export type Subcommand = 'serve' | 'authorize' | 'doctor';

export interface ParsedInvocation {
  readonly command: Subcommand;
  readonly rest: readonly string[];
}

export function parseSubcommand(argv: readonly string[]): ParsedInvocation {
  const [first, ...rest] = argv;
  if (first === 'authorize') return { command: 'authorize', rest };
  if (first === 'doctor') return { command: 'doctor', rest };
  if (first === 'serve') return { command: 'serve', rest };
  // No subcommand (or an unknown token) → run the server; the token, if any, is left
  // in `rest` for the composition root to reject via the config contract (CFG-5).
  return { command: 'serve', rest: argv };
}
