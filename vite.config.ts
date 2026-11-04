/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import { defineConfig } from "vite";

// Which commit a build came from, shown next to the version in the HUD. The
// version only changes at a release but the exe is rebuilt all the time, so
// this is what tells an out-of-date exe apart. "+" = built with uncommitted
// changes to tracked files; the dev server says "dev" (it always runs the
// working tree as it is).
function buildId(): string {
  const git = (args: string) =>
    execSync(`git ${args}`, {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    const dirty = git("status --porcelain --untracked-files=no") !== "";
    return git("rev-parse --short HEAD") + (dirty ? "+" : "");
  } catch {
    return "unknown"; // not a git checkout (a source zip, say)
  }
}

export default defineConfig(({ command }) => ({
  define: {
    __BUILD_ID__: JSON.stringify(command === "build" ? buildId() : "dev"),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
