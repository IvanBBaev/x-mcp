// Fixture loader — reads canned X API JSON from the SOURCE tree (`test/fixtures/`), not
// the build dir, since tsc does not copy .json. npm scripts run from the repo root, so
// resolving against process.cwd() is stable. Add fixtures as endpoints get wired.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Load and parse `test/fixtures/<relPath>` (e.g. `posts/single.json`). */
export function loadFixture<T = unknown>(relPath: string): T {
  const abs = join(process.cwd(), 'test', 'fixtures', relPath);
  return JSON.parse(readFileSync(abs, 'utf8')) as T;
}
