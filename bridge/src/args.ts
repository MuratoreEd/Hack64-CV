// Command-line parsing shared by both bridge entry points. Dependency-free so
// the viewer's test suite can exercise it without loading the native FFI.

/** `--port=N` from argv, or the fallback. Rejects anything that isn't a port:
 * a typo used to reach listen() as NaN, which quietly picked a RANDOM free
 * port and left the viewer pointed at one nothing was listening on. */
export function parsePort(args: readonly string[], fallback: number): number {
  const arg = args.find((a) => a.startsWith("--port="));
  if (!arg) return fallback;
  const text = arg.slice("--port=".length);
  const port = Number(text);
  if (text === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid ${arg} (expected a port number, 1-65535)`);
  }
  return port;
}
