// Builds the standalone Windows executable:
//   viewer (dist/, prebuilt by `npm run build`) + bridge (esbuild bundle)
//   + koffi's prebuilt native module, packed into one exe with @yao-pkg/pkg.
//
//   npm run build:exe      ->  dist-exe/InvisibleWallViewer.exe  (everyday, with dev tools)
//   npm run build:release  ->  dist-exe/Hack64CV.exe             (public release)
//
// --release rebuilds dist/ itself with IWV_RELEASE=1, which drops the
// development tools (see __DEV_TOOLS__ in vite.config.ts), and names the exe
// for publishing. dist/ is left holding the release build; `build:exe`
// rebuilds it.
//
// Staging layout (build-exe/app/):
//   index.cjs                                  bundled bridge/src/standalone.ts
//   dist/**                                    built viewer (served from snapshot)
//   node_modules/koffi/{package.json,index.js} koffi loader
//   node_modules/koffi/build/koffi/win32_x64/koffi.node
// pkg embeds dist/ + koffi as assets; its runtime extracts the .node to a temp
// dir before dlopen (native modules can't load from the snapshot directly).

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "build-exe", "app");
const release = process.argv.includes("--release");
const outExe = path.join(
  root,
  "dist-exe",
  release ? "Hack64CV.exe" : "InvisibleWallViewer.exe",
);
const TARGET = "node24-win-x64";
// Never a literal: src/version.ts is the single source (see it for why).
const { version } = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);

function step(name) {
  console.log(`\n=== ${name} ===`);
}

if (release) {
  step("build viewer (release: no dev tools)");
  execSync("npx vite build", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, IWV_RELEASE: "1" },
  });
}

// 0. Preconditions
if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  console.error("dist/index.html missing - run `npm run build` first " +
    "(or use `npm run build:exe`, which chains it).");
  process.exit(1);
}

step("clean staging");
fs.rmSync(path.join(root, "build-exe"), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

step("bundle bridge (esbuild)");
await build({
  entryPoints: [path.join(root, "bridge", "src", "standalone.ts")],
  outfile: path.join(stage, "index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["koffi"],
  logLevel: "info",
});

step("stage viewer + koffi");
fs.cpSync(path.join(root, "dist"), path.join(stage, "dist"), {
  recursive: true,
});
const koffiSrc = path.join(root, "bridge", "node_modules", "koffi");
const koffiDst = path.join(stage, "node_modules", "koffi");
fs.mkdirSync(path.join(koffiDst, "build", "koffi", "win32_x64"), {
  recursive: true,
});
for (const f of ["package.json", "index.js"]) {
  fs.copyFileSync(path.join(koffiSrc, f), path.join(koffiDst, f));
}
fs.copyFileSync(
  path.join(koffiSrc, "build", "koffi", "win32_x64", "koffi.node"),
  path.join(koffiDst, "build", "koffi", "win32_x64", "koffi.node"),
);

fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "sm64-iwv-standalone",
      version,
      bin: { iwv: "index.cjs" },
      pkg: {
        assets: ["dist/**/*", "node_modules/koffi/**/*"],
      },
    },
    null,
    2,
  ),
);

step(`pack exe (${TARGET})`);
fs.mkdirSync(path.dirname(outExe), { recursive: true });
execSync(`npx pkg . --target ${TARGET} --output "${outExe}"`, {
  cwd: stage,
  stdio: "inherit",
});

step("done");
const mb = (fs.statSync(outExe).size / 1024 / 1024).toFixed(1);
console.log(`${outExe} (${mb} MB)`);
