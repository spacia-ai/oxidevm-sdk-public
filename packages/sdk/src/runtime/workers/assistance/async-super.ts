import type { File } from "@babel/types";
import { traverseModule } from "./module-syntax.js";

// shortcut: Normalize async super arrows until pinned SWC passes the compiler regression without this step.
export function lowerAsyncSuper(tree: File): boolean {
  let changed = false;
  traverseModule(tree, {
    Super(path) {
      let owner = path.getFunctionParent();
      while (owner?.isArrowFunctionExpression() === true) {
        if (owner.node.async) {
          owner.arrowFunctionToExpression();
          changed = true;
          break;
        }
        owner = owner.getFunctionParent();
      }
    },
  });
  return changed;
}
