# SISO Workspace fleet adapter

This opt-in adapter reuses DevSpace's existing single-owner OAuth/PKCE,
revocation, SQLite token persistence and Streamable HTTP transport. When
`SISO_FLEET_CONFIG` names a private enrollment file, MCP exposes only the fleet
tools; DevSpace's implicit local-workspace tools are not registered. Without
that variable, the original DevSpace behavior is unchanged.

## Architecture

One HTTPS gateway accepts authenticated MCP requests. Separately enrolled Python
nodes poll `/fleet/poll/:node` outbound over HTTPS (or loopback on the gateway
machine). Nodes listen on no network ports. Each credential belongs to exactly
one node; it does not authorize MCP calls or another node's reports. Only the
operator's enrollment file can define node IDs, aliases and allowed roots.

Version 1 is intentionally one owner, not a multi-tenant service. VPS nodes are
not automatically discovered/enrolled. Local GUI automation is not implemented.

## Tools

`workspace_help`, `nodes_list`, `node_metrics`, `fs_list`, `fs_stat`, `fs_read`, `fs_write`, `fs_edit`, `fs_search`,
`shell_exec`, `job_start`, `job_status`, `job_list`, `job_logs`, `job_cancel`.

File and command tools require a node/alias. Job operations use the globally
unique returned job ID and resolve its owning node centrally. Python, git, Sage,
SAT and other installed tools are invoked through shell commands with explicit
cwd; this does not imply every such dependency is installed.

An operator may add `profiles` to the private enrollment file, for example
`{"laptop":{"node":"macbook","title":"SISO Laptop"}}`. This exposes
`/mcp/laptop` with its own protected-resource metadata. Tokens and sessions are
bound to that exact resource; node defaults, node listings and all job lookups
are constrained to the profile's machine. `/mcp` remains the combined fleet app.
Profile names and URLs remain stable across releases. A disabled enrollment
(`enabled:false`) cannot poll or accept new operations.

`node_metrics` runs a fresh native OS sample, returning CPU utilization/cores/load,
RAM, swap, uptime and root disk space with timestamps and availability methods.
macOS available memory is an explicitly labelled estimate. Metrics report errors
or unavailable values rather than fabricating zero usage. `workspace_help` reads
the bundled root `SKILL.md` so an agent can learn the interface through the app.

## Security and durability contract

- OAuth is required before MCP initialization or tool discovery. Nodes use
  independent 256-bit enrollment credentials. Keep all private configuration,
  SQLite databases, requests and results outside Git in owner-only directories.
- File paths are root-contained. Descriptor-relative `O_NOFOLLOW` traversal
  refuses symlink escapes and common secret paths. Writes are atomic; creating
  an existing file fails unless overwrite was explicitly requested. Edits
  require exactly one matching old string. Root directories must exist.
- Shell is **not a sandbox**: it has the node user's OS authority. The environment
  passed to commands is minimal and does not inherit gateway/node token variables.
  Only connect trusted clients, do not retrieve credentials, and obtain approval
  for destructive work. Shell can deliberately bypass filesystem-tool restrictions.
- Requests, node assignment, status and results persist in `fleet.sqlite` at the
  gateway. Sync calls wait at most 12 seconds, then return a pending job ID.
  Do not resubmit pending mutations; query that ID in any conversation.
- Dispatch is at-most-once. If a connection dies after dispatch but before receipt,
  a task can remain `dispatched` with uncertain acceptance. It is not automatically
  rerun. Inspect the node receipts before deciding whether to issue new work.
- Every accepted task has a durable node receipt and detached supervisor. Shell
  stdout/stderr are streamed to files. Gateway/daemon restarts and client
  disconnects do not kill those supervisors. Machine reboot does kill computation;
  missing supervisors become `interrupted`, never falsely `completed`.
- Cancellation targets a job receipt, not a supplied PID; its existing supervisor
  terminates the owned process group. Timeout/cancellation are distinct terminal
  states. Cancellation and log requests remain dispatchable when compute slots
  are full. Four compute jobs can run per node.
- Central results include bounded output tails. Full logs remain on the execution
  node (up to 256 MiB per stream, with truncation reported). `job_logs` fetches byte
  pages and caches each response centrally. An offline node's full logs cannot be
  fetched until it reconnects. State/log retention is manual in this version.
- File reads/searches/results are bounded. If a result exceeds the transport
  budget, the operation reports failure asking for a smaller/refined query.
- Existing external editors/shells are not transactionally coordinated with
  filesystem edits. Use separate worktrees for concurrent work on the same repo.

## Installation

Build the pinned source with `npm ci`, `npm run build`. Install runtime
dependencies and copy the build to the selected gateway machine. Preserve
existing owner credentials; do not initialize a replacement over existing state.

For a **fresh** deployment, `node scripts/siso-configure.mjs HTTPS_ORIGIN
OWNER_AUTH_JSON` creates private gateway and initial node enrollments. It refuses
to overwrite an existing gateway configuration. Copy only each node's own
configuration to that node through an authenticated private channel.

Gateway environment:

```text
DEVSPACE_CONFIG_DIR=<private config directory>
DEVSPACE_STATE_DIR=<private gateway state directory>
SISO_FLEET_CONFIG=<private enrollment file>
DEVSPACE_TRUST_PROXY=true
```

Start with `node dist/cli.js serve`. The node needs only Python 3:
`python3 scripts/siso-node.py --config <private node configuration>`.

`scripts/siso-launchd.mjs` generates only this adapter's launchd plist. Default
mode creates a user LaunchAgent. `--system` stages a plist with an explicit
unprivileged UserName for operator installation as a system LaunchDaemon. It
refuses to overwrite existing plists. Back up any old agent and avoid running
both LaunchAgent and LaunchDaemon for the same node. File locking prevents two
node writers. The gateway binds only to localhost; the HTTPS tunnel is its ingress.

## Verification and rollback

```bash
npm run typecheck
npm test
bash scripts/test-siso-fleet.sh
node scripts/siso-smoke.mjs HTTPS_ORIGIN OWNER_AUTH_JSON NODE WORKSPACE_ROOT
```

The smoke uses real owner approval, PKCE, token refresh, MCP discovery and calls;
it never prints tokens and revokes its test tokens afterward. `SISO_PUBLIC_IP`
can force an observed public IP while retaining TLS hostname verification.
`--restart-test` is deployment-specific: it restarts the two Mini system services
over the existing SSH alias, reconnects with the same OAuth token, and proves the
same job PID completes and returns logs. Do not use that flag on another deployment.

These tests are **not** a ChatGPT acceptance substitute. Installation in ChatGPT
and a real tool call there must be observed separately before calling the
connector operational.

Rollback: stop only `com.siso.workspace-gateway` and `com.siso.workspace-node`,
disable only the dedicated tunnel route, and preserve the private state directory
and outstanding job supervisors. Never delete the user's existing tunnel setup or
job data. Unsetting `SISO_FLEET_CONFIG` restores the original DevSpace tool surface.
