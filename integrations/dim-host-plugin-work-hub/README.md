# Work Hub DIM recipient host plugin

This optional host plugin uses DIM's `WorkspaceHostPlugin.guest.operations`
contract to expose only assignment read, delivery acknowledgment, and exact-source
result reporting. It is not a remote execution service and does not own tasks,
Git, CI, workspaces, or agent sessions.

The trusted operator selects one private registration per target workspace UUID.
Each registration contains the Work Hub origin, installation and host IDs, the
Work Hub workspace ID, target workspace UUID, current runtime fingerprint,
OpenCode loopback port, and a private integration credential. The mode-`0600`
configuration belongs under the DIM state root at
`plugins/work-hub/recipients.json`, or at a separately protected path selected
by `WORK_HUB_RECIPIENT_CONFIG`.

Every operation derives the workspace UUID from DIM's authenticated caller and
re-attests the current runtime fingerprint before contacting Work Hub. Tokens are
exchanged and consumed inside the plugin; no bearer is returned to the guest tool.
Expiry, replacement, task/session closure, binding-generation change, installation
disablement, or explicit credential revocation fails closed at the owning service.

The source was checked against DIM source `ff4ec121e07d351aabb717c3fb030c76ce67e63a`.
`@slop-lab/dim-host-core` is not published on the public npm registry, so the
coordinator must review and package this built artifact through the deployed DIM
source/installer rather than asking a workspace agent to install it. Five-host
installation and controller restart remain operator deployment steps.
