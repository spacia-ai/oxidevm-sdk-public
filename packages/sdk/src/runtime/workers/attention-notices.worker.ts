/// <reference lib="webworker" />

// Counts host attention for producers on another origin (`attention-notices.ts`). This
// worker never runs guest code, so its event loop receives each notice while the execution worker
// runs a guest slice.

import { serveAttentionNotices } from "./attention-notices.js";

serveAttentionNotices(self);
