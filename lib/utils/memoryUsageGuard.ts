// Guard against a platform bug seen on constrained Homey models (confirmed on a
// Homey (Early 2016), model id homey1s) where libuv's uv_resident_set_memory
// syscall is unavailable, making process.memoryUsage() throw:
//   Error: ENOENT: no such file or directory, uv_resident_set_memory
//
// That throw is not this app's own crash — it happens inside winston's built-in
// ExceptionHandler (getProcessInfo() calls process.memoryUsage() unguarded),
// which homey-betterstack registers with handleExceptions:true on every
// transport (see app.ts). Node's default behaviour for a throw inside an
// uncaughtException handler is to crash immediately and uncatchably, printing
// the raw stack instead of whatever the ORIGINAL error was — a user's
// diagnostic report showed exactly this masking a real "ready_timeout" startup
// failure, and Sentry has zero events for that message despite the report,
// because the exception handler that would have reported it crashed first.
//
// Patching memoryUsage() to degrade to zeros instead of throwing lets winston's
// exception handler finish normally on this hardware, restoring both the app's
// crash-recovery behaviour and Sentry reporting for whatever the real error is.
// This app never reads process.memoryUsage() itself (the measure_mem_usage
// capability comes from the Deco router's own reported stats), so there is
// nothing here to silently corrupt.
export function installMemoryUsageGuard(proc: NodeJS.Process = process): void {
  const realMemoryUsage = proc.memoryUsage.bind(proc);
  // Captured before reassignment below — safeMemoryUsage.rss must not call
  // through proc.memoryUsage.rss() at invocation time, since by then
  // proc.memoryUsage *is* safeMemoryUsage and that would recurse forever.
  const realRss = proc.memoryUsage.rss ? proc.memoryUsage.rss.bind(proc.memoryUsage) : () => 0;
  const zeroMemoryUsage: NodeJS.MemoryUsage = { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };

  const safeMemoryUsage = ((...args: Parameters<typeof proc.memoryUsage>) => {
    try {
      return realMemoryUsage(...args);
    } catch (e) {
      return zeroMemoryUsage;
    }
  }) as typeof proc.memoryUsage;

  safeMemoryUsage.rss = () => {
    try {
      return realRss();
    } catch (e) {
      return 0;
    }
  };

  proc.memoryUsage = safeMemoryUsage;
}
