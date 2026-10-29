# Work Hub OpenCode recipient tools

This optional global OpenCode plugin advertises `workhub_assignment`,
`workhub_ack`, and `workhub_result`. Tool arguments never contain a Work Hub,
DIM, OpenCode, or host credential. The OpenCode SDK supplies the current native
session ID; the tool calls the selected DIM guest operation and returns only its
bounded result.

Build from the Work Hub root with `npm run build`. The operator can copy the
resulting private package or its built `dist/index.js` to the global OpenCode
plugin directory. Repository-specific configuration is not required. Installing
or restarting global plugins in existing workspaces remains an operator action.

The plugin is useful only when the matching reviewed DIM host plugin is selected
for that workspace. An absent integration fails explicitly and does not fall
back to another workspace or reveal credentials.
