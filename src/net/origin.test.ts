import { describe, it, expect } from "vitest";
import { isAllowedOrigin } from "./origin";

describe("isAllowedOrigin", () => {
  it("accepts a handshake with no Origin (non-browser tooling)", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin("")).toBe(true);
  });

  it("accepts loopback origins on any port", () => {
    for (const o of [
      "http://localhost:5173", // vite dev server
      "http://localhost:8081", // the exe serving the viewer itself
      "http://localhost", // default port
      "https://localhost:5173",
      "http://127.0.0.1:8081",
      "http://127.0.0.2:1234", // all of 127.0.0.0/8 is loopback
      "http://[::1]:5173",
      "http://LOCALHOST:5173",
    ]) {
      expect(isAllowedOrigin(o), o).toBe(true);
    }
  });

  it("rejects remote origins", () => {
    for (const o of [
      "https://evil.example",
      "http://evil.example:8081",
      "http://192.168.1.50:5173", // LAN, not this machine
      "http://10.0.0.1",
    ]) {
      expect(isAllowedOrigin(o), o).toBe(false);
    }
  });

  it("rejects hosts that merely look loopback", () => {
    for (const o of [
      "http://localhost.evil.example",
      "http://evil-localhost.example",
      "http://127.0.0.1.evil.example",
      "http://notlocalhost",
      "http://127.0.0.1x",
    ]) {
      expect(isAllowedOrigin(o), o).toBe(false);
    }
  });

  it('rejects the opaque "null" origin (file:// pages, sandboxed iframes)', () => {
    expect(isAllowedOrigin("null")).toBe(false);
  });

  it("rejects unparseable origins rather than guessing", () => {
    for (const o of ["localhost:5173", "://localhost", "  "]) {
      expect(isAllowedOrigin(o), o).toBe(false);
    }
  });
});
