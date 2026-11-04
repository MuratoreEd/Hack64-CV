/// <reference types="vite/client" />
declare module "*.css";

/** Commit the viewer was built from ("abc1234", "+" if built with uncommitted
 * changes), or "dev" under the dev server. Injected by vite.config.ts. */
declare const __BUILD_ID__: string;
/** ISO timestamp of the build (of the dev server's start under "dev"). */
declare const __BUILD_TIME__: string;
