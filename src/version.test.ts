import { describe, it, expect } from "vitest";
import { APP_VERSION } from "./version";
import pkg from "../package.json";
import bridgePkg from "../bridge/package.json";
import changelog from "../CHANGELOG.md?raw";

describe("APP_VERSION", () => {
  it("looks like a semver version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches package.json", () => {
    expect(pkg.version).toBe(APP_VERSION);
  });

  it("matches bridge/package.json", () => {
    expect(bridgePkg.version).toBe(APP_VERSION);
  });

  it("has a CHANGELOG entry", () => {
    expect(changelog).toContain(`## ${APP_VERSION}`);
  });
});
