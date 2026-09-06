# SISO Workspace

One maintained execution package, multiple machine-scoped ChatGPT MCP apps,
outbound-only node agents, and durable jobs. Includes a public agent usage
[skill](SKILL.md), also available through the authenticated `workspace_help` tool.

## App endpoints

Keep one stable HTTPS origin under operator control. The combined app uses
`/mcp`; optional configured profiles use `/mcp/laptop`, `/mcp/mac-mini`,
`/mcp/oracle`, `/mcp/byk`, or other explicitly enrolled profile names.
These are paths, not claims that a public demonstration server is available.

OAuth grants are bound to the exact resource URL. A profile's MCP tools and job
lookups are restricted to its assigned machine. The combined app intentionally
has fleet-wide authority. Private node credentials cannot initialize MCP.

Machine agents connect outbound; no machine filesystem is mounted by the gateway.
The same software serves every app, while private enrollment determines which
machine and roots each app may access. This is a single-owner system, not a
multi-tenant security product.

## Tools

`workspace_help`, `nodes_list`, `node_metrics`, `fs_list`, `fs_stat`, `fs_read`,
`fs_write`, `fs_edit`, `fs_search`, `shell_exec`, `job_start`, `job_status`,
`job_list`, `job_logs`, `job_cancel`.

`node_metrics` samples CPU utilization/load/cores, RAM availability/usage, swap,
uptime and disk headroom using native macOS or Linux interfaces. It reports its
timestamp, measurement method and errors rather than inventing missing values.

Jobs survive client disconnects and gateway/agent restarts. Full logs remain on
the execution node; IDs, assignment, state, results and bounded tails are stored
centrally. Machine reboots interrupt computation. Ambiguous dispatched mutations
are not automatically replayed. Read [the operational contract](docs/siso-workspace-fleet.md).

## Security

- Preserve private configuration, OAuth credentials and job data outside Git.
- Bind the gateway to localhost behind an authenticated HTTPS-capable ingress.
- File tools enforce root boundaries and refuse common secret paths/symlinks.
- Shell has the execution user's OS authority, not a universal sandbox. Routing
  isolation does not erase SSH keys or other privileges already held by that OS
  user. Do not use shell to evade app restrictions.
- The supplied Linux systemd unit runs under a dedicated unprivileged user, with
  protected system/home directories and writes limited to its new workspace and
  state directories. Existing production services are not granted sudo access.
- An app registration and real ChatGPT tool invocation must be verified separately
  from standalone MCP tests. This repository does not install a ChatGPT app.

## Build and deploy

Requires Node matching `package.json` for the gateway and Python 3.12+ for release
installation. The node daemon itself uses only Python's standard library.

```bash
npm ci
npm run typecheck
npm test
npm run test:fleet
npm run build
```

For fresh installations, `scripts/siso-configure.mjs` creates owner-private
initial configuration. `scripts/siso-enroll.mjs` adds a node/profile without
overwriting other enrollments and backs up the private gateway configuration.
Node identity, permitted roots and deployment hosts are operator decisions; never
enroll a guessed server or copy one node's credential to another.

Start the gateway using `node dist/cli.js serve` with `DEVSPACE_CONFIG_DIR`,
`DEVSPACE_STATE_DIR`, `SISO_FLEET_CONFIG` and proxy settings from the private
configuration. Run nodes with `python3 scripts/siso-node.py --config <node.json>`.
Launchd and systemd helpers are included; install only the services explicitly
owned by this package.

## Update once, roll out to every enrolled machine

```bash
npm run release:all -- /absolute/path/to/private-deployment-inventory.json
```

This explicit promotion command requires clean committed source, runs tests and
the build, creates a SHA-256-identified runtime artifact, and rolls it out using
the operator's existing SSH access. It does not publish credentials or add SSH
keys. Inventory fields are `targets[]` with `id`, `expectedHost`, `ssh` (omit for
local), `role` (`gateway` or `node`), `python`, `runtimeRoot`, `stagingDir`, optional
`path`, `restart[]`, and `check[]` shell commands. The inventory is private and
trusted; it is never supplied by an MCP caller.

Use `npm run release:build` and `node scripts/siso-rollout.mjs ARTIFACT INVENTORY`
for a build plus dry-run plan. Add `--apply` to perform the rollout. Installation
verifies the archive hash, rejects unsafe archive members, retains immutable
release directories, and switches `current` atomically. A failed restart/check
restores the previous pointer when one exists. The operator still needs a real
MCP smoke test after deployment; service-active is not a full acceptance claim.

**Package updates do not change app URLs, private configuration or job state.**
Old releases are retained for rollback and in-flight supervisors. Review retention
only after their jobs finish. This is not an unattended pull of arbitrary commits
from a moving branch. Keep externally supplied tool contracts backward compatible;
new tools may require refreshing a client's tool catalog, not replacing its URL.

## Provenance

Derived from [Waishnav/DevSpace](https://github.com/Waishnav/devspace), v1.0.6,
upstream commit `3bd0378b128c048add810dff00efeff4e7326eb9`. The existing OAuth,
Streamable HTTP transport, CLI and regression suite are retained. The MIT license
and original copyright are preserved. The original README is retained in
`docs/devspace-upstream-readme.md`. SISO additions provide scoped fleet routing,
native metrics, durable node execution, release tooling and the usage skill.
