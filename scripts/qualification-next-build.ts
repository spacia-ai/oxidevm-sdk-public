// User-approved production-build budget; enclosing workflows include setup and reopen.
export const nextBuildTimeoutMs = 2 * 60 * 60_000;
export const nextWorkflowTimeoutMs = nextBuildTimeoutMs + 60 * 60_000;
export const qualifiedAppsTimeoutMs = 2 * nextWorkflowTimeoutMs + 2 * 60 * 60_000;
