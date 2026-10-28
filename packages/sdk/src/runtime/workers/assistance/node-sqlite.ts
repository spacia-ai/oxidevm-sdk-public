import { unavailableNodeApi } from "./node-capability.js";

/** Importing the constructor grants no database capability. SQLite execution
 * remains outside the qualified browser API contract. */
function DatabaseSync(): never { return unavailableNodeApi("sqlite.DatabaseSync"); }
export const nodeSqlite = Object.freeze({ DatabaseSync });
