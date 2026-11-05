/** 17 (ADR 0028) adds module.files, module.spawn and module.commands: modules run in the hosted frame. */
/** 18 carries `workspaceInUse` to the frame and the reason of an ephemeral workspace back to the page; the frame
 * keeps each embedding origin's storage apart. */
export const FRAME_PROTOCOL_VERSION=18;
