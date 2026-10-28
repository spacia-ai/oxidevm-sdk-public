# Workspace persistence

Userspace persists framework caches as ordinary workspace files. This includes
`.next` and Vite's dependency cache. Each framework decides whether its cache
can be reused. Persistence does not make a cache valid across incompatible
framework or dependency versions.

After a full publication, Rust captures cumulative changes against the
acknowledged snapshot baseline. Storage retains the snapshot's existing content
references and publishes the delta. Rust compares content revisions, inode
metadata and names. It does not export unchanged file bodies or use editor watch
events as a durable journal. Metadata enumeration remains part of capture.

The delta includes removals, renames, hardlinks, metadata and mapped-file writes.
It compacts through a full capture when it exceeds 16 MiB or 4,096 changed paths.
A replaced runtime or persistence owner starts with a full capture. Existing
snapshot and delta formats remain readable.

One publication runs at a time. Later writes share one pending publication and
retain the first mutation's deadline. Explicit flushes wait for durable
acknowledgement. A failed commit leaves changes dirty. Writes after a captured
revision need a later commit. Publication and restore retain content integrity,
producer-retirement and crash-recovery checks.

Workspace persistence saves files. Native snapshots and suspend still reject a
live JavaScript process. They do not save its heap or connections.
