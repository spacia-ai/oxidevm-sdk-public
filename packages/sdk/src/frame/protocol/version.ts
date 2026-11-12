/** 17 (ADR 0028) adds module.files, module.spawn and module.commands: modules run in the hosted frame. */
/** 18 carries `workspaceInUse` to the frame and the reason of an ephemeral workspace back to the page; the frame
 * keeps each embedding origin's storage apart. */
/** 19 (ADR 0030) carries preview site access: `exposePort`'s `siteAccess` and `preview.sites`. Blocked-site reports
 * stay in the page that frames the previews and never cross this protocol. The same release's 19 also carries the busy
 * `auto-save-paused` restore point event (`reason: "busy"` with its `cause`). */
export const FRAME_PROTOCOL_VERSION=19;
