---
name: siso-workspace
description: Use SISO Workspace MCP apps to inspect machine resources, work with permitted files, run shell or Python commands, and manage durable remote jobs. Applies to combined fleet and machine-specific apps; does not authorize deployment, credential access, or work on other machines.
---

# SISO Workspace

Use the connected MCP tools, not an assumed SSH connection or local terminal.
The machine executing this skill may not be the requested execution node.

## Select and check the machine

1. Call `nodes_list`. Use the returned node IDs, aliases, approved roots, online
   status and agent versions. Do not invent IDs, directories, or capabilities.
2. Machine-specific apps expose only their assigned node. Their tools may omit
   `node`; the combined app requires it. Supplying another node or another
   node's job ID must not be used to bypass the selected app's permissions.
3. Call `node_metrics` before resource-heavy work or when asked about CPU/RAM.
   If the response is pending, retrieve that operation with `job_status`.
   Report the sample timestamp, not just the numbers.

Metrics include CPU utilization over a short sample, logical cores, 1/5/15-minute
load averages, RAM total/available/used, swap, uptime and disk free space for
approved roots. Load average is not CPU percent. macOS available RAM is explicitly
an estimate; read `availability_method` and `errors`. Do not substitute zero for
an unavailable measurement or treat an old/offline sample as current.

## Files and short commands

- `fs_list`, `fs_stat`, `fs_read`, `fs_search` inspect permitted paths. Read/log
  pages have offsets and limits; request the next page instead of assuming the
  first page contains the whole file.
- `fs_write` creates text and refuses to overwrite unless explicitly requested.
  `fs_edit` replaces exactly one matching old string. Read before editing.
- `shell_exec` runs a command with an explicit `cwd`. Use it for Python, git,
  installed solvers, and tasks not covered by dedicated file tools. Do not assume
  a dependency exists; check it when relevant. Preserve existing uncommitted work.
- Paths must be inside an approved root. Do not assume `~` expansion. File tools
  refuse common secret paths and symlink escapes. Shell has the OS user's
  authority, not a filesystem sandbox; do not use it to evade a denied action,
  retrieve credentials, or reach another machine outside the user's scope.

## Durable computations

Use `job_start(node, cwd, command, timeout_seconds)` for long runs. Check resource
headroom and existing `job_list` entries first. Obtain a budget before starting
an expensive or effectively unbounded computation. Do not cancel another job to
make room without authorization.

Save the returned `job_id` in the task's durable notes. Any later conversation
with the same permitted machine access can query `job_status` and `job_logs`.
The status sequence is normally `queued → dispatched → running → completed`.
Failure, timeout, cancellation and interruption are distinct terminal states.

- A pending response is not a failed submission. **Do not resubmit a mutation or
  computation just because the original HTTP call ended.** Poll its existing ID.
- `dispatched` without progress can mean uncertain delivery. Inspect receipts or
  ask the operator; do not blindly rerun potentially executed work.
- `completed` plus exit code 0 establishes command success, not mathematical
  correctness. Independently check witnesses/certificates when the task requires it.
- `job_logs` fetches bounded stdout/stderr pages from the owning node. Full logs
  remain there; central records retain results and bounded tails. Offline nodes
  cannot supply additional log pages until they reconnect.
- `job_cancel` requests cancellation of one exact job. Verify the terminal state
  afterward; a cancellation request is not proof the process has stopped.
- Jobs survive client disconnects and gateway/node-agent restarts. Machine reboot
  kills computation; recovery reports `interrupted` and does not rerun it.

## Version and access boundaries

Normal package updates keep app URLs, private configuration and job state intact.
An operator promotes tested releases; the skill must not install updates, rotate
credentials, modify services or reconfigure tunnels merely to perform ordinary
file/computation work. New tools may require an app tool-catalog refresh.

If tools are missing, the app is disconnected, a node is offline, or authorization
fails, report that exact boundary. Do not claim a real ChatGPT invocation was
verified by a standalone MCP test. `workspace_help` returns this bundled guide
without requiring the agent to find a repository or install another skill.
