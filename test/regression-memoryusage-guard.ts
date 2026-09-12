// Regression test for the memoryUsage() ENOENT crash on constrained Homey
// models (see lib/utils/memoryUsageGuard.ts for the full explanation).
//
// Simulates a process object whose memoryUsage() (and memoryUsage.rss())
// throw ENOENT, exactly as observed on a Homey (Early 2016) / homey1s.
// Asserts installMemoryUsageGuard() makes both degrade to safe defaults
// instead of throwing, and — critically — does not recurse (the bug this
// script would have shipped if .rss() called through the *patched*
// process.memoryUsage instead of the captured original).
//
// Run with: npx tsc -p test/tsconfig.json && node test/dist/test/regression-memoryusage-guard.js

import { installMemoryUsageGuard } from '../lib/utils/memoryUsageGuard';

function main() {
  const enoent = () => {
    throw Object.assign(new Error('ENOENT: no such file or directory, uv_resident_set_memory'), {
      errno: -2,
      code: 'ENOENT',
      syscall: 'uv_resident_set_memory',
    });
  };

  const fakeMemoryUsage: any = () => enoent();
  fakeMemoryUsage.rss = () => enoent();

  const fakeProcess = { memoryUsage: fakeMemoryUsage } as unknown as NodeJS.Process;

  installMemoryUsageGuard(fakeProcess);

  // memoryUsage() must not throw, and must return a well-shaped zeroed object.
  let result: NodeJS.MemoryUsage;
  try {
    result = fakeProcess.memoryUsage();
  } catch (e) {
    return fail(`memoryUsage() threw after the guard was installed: ${e}`);
  }
  assert(result.rss === 0 && result.heapTotal === 0 && result.heapUsed === 0, `expected a zeroed MemoryUsage object, got ${JSON.stringify(result)}`);

  // memoryUsage.rss() must not throw either, and — the actual bug being
  // guarded against — must not recurse forever by calling back through
  // fakeProcess.memoryUsage.rss() (which is now the patched function itself).
  let rss: number;
  const start = Date.now();
  try {
    rss = fakeProcess.memoryUsage.rss();
  } catch (e) {
    return fail(`memoryUsage.rss() threw after the guard was installed: ${e}`);
  }
  const elapsedMs = Date.now() - start;
  assert(rss === 0, `expected memoryUsage.rss() to degrade to 0, got ${rss}`);
  assert(elapsedMs < 1000, `memoryUsage.rss() took ${elapsedMs}ms — looks like it recursed instead of returning immediately`);

  console.log('PASS: process.memoryUsage() and .rss() degrade to safe defaults instead of throwing, with no recursion.');
}

function assert(cond: boolean, msg: string) {
  if (!cond) fail(msg);
}

function fail(msg: string) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

main();
