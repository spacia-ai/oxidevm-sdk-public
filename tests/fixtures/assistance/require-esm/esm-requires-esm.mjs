import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const inner = require("./named.mjs").a;
