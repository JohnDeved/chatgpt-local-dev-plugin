import type { ElectrobunConfig } from "electrobun";
export default {
  app: { name: "Local Dev", identifier: "local.dev.menubar", version: "0.7.0" },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/main/index.ts" },
    copy: { "dist/renderer": "views/mainview" },
    mac: { bundleCEF: false, createDmg: false, codesign: false, notarize: false },
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
