#!/usr/bin/env python3
"""Outbound-only SISO execution node. Credentials/config/state are outside Git.

Each accepted request gets a detached supervisor and durable receipt. Ambiguous
requests are never blindly replayed. File tools use descriptor-relative traversal
with O_NOFOLLOW. Authenticated shell is explicitly OS-user authority, not a sandbox.
"""
import argparse
import contextlib
import hashlib
import json
import os
import platform
import re
import shutil
from pathlib import Path
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

TERMINAL = {"completed", "failed", "cancelled", "timed_out", "interrupted"}
DENIED = {".env", ".ssh", ".aws", ".devspace", ".siso-workspace", ".npmrc", ".netrc", ".pypirc", ".git-credentials", "auth.json", "credentials.json"}
SKIP = {".git", "node_modules", ".venv", "venv", "__pycache__"}
MAX_FILE = 1024 * 1024
MAX_LOG = 256 * 1024 * 1024
AGENT_VERSION = "1.1.0"


def metrics(config):
    """OS-native aggregate metrics only; never returns process arguments or environment."""
    errors = []
    result = {"sampled_at": time.time(), "agent_version": AGENT_VERSION, "os": platform.system(),
              "cpu": {"logical_cores": os.cpu_count(), "load_average": list(os.getloadavg()), "utilization_percent": None},
              "memory": {}, "swap": {}, "disks": []}
    try:
        if sys.platform == "linux":
            def cpu_ticks():
                values = [int(v) for v in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
                return sum(values), values[3] + values[4]
            before = cpu_ticks()
            time.sleep(1)
            after = cpu_ticks()
            total, idle = after[0] - before[0], after[1] - before[1]
            result["cpu"].update(utilization_percent=round(100 * (1 - idle / total), 2) if total > 0 else None, sample_seconds=1, method="proc_stat_delta")
            mem = {m.group(1): int(m.group(2)) * 1024 for line in Path("/proc/meminfo").read_text().splitlines()
                   if (m := re.match(r"(\w+):\s+(\d+)\s+kB", line))}
            available = mem.get("MemAvailable", mem["MemFree"])
            result["memory"] = {"total_bytes": mem["MemTotal"], "available_bytes": available,
                                "used_bytes": mem["MemTotal"] - available, "availability_method": "kernel_MemAvailable" if "MemAvailable" in mem else "MemFree_fallback"}
            result["swap"] = {"total_bytes": mem["SwapTotal"], "used_bytes": mem["SwapTotal"] - mem["SwapFree"]}
            result["uptime_seconds"] = float(Path("/proc/uptime").read_text().split()[0])
        elif sys.platform == "darwin":
            top = subprocess.run(["/usr/bin/top", "-l", "2", "-s", "1", "-n", "0"], capture_output=True, text=True, timeout=8, check=True).stdout
            samples = re.findall(r"CPU usage:.*?([\d.]+)% idle", top)
            result["cpu"].update(utilization_percent=round(100 - float(samples[-1]), 2) if samples else None, sample_seconds=1, method="top_second_sample")
            total = int(subprocess.check_output(["/usr/sbin/sysctl", "-n", "hw.memsize"], text=True, timeout=3))
            vm = subprocess.check_output(["/usr/bin/vm_stat"], text=True, timeout=3)
            page = int(re.search(r"page size of (\d+) bytes", vm).group(1))
            pages = {m.group(1): int(m.group(2)) for line in vm.splitlines() if (m := re.match(r"(.+?):\s+(\d+)\.", line))}
            available = min(total, page * sum(pages.get(k, 0) for k in ["Pages free", "Pages inactive", "Pages speculative"]))
            result["memory"] = {"total_bytes": total, "available_bytes": available, "used_bytes": total - available,
                                "availability_method": "estimated_free_plus_inactive_plus_speculative", "compressed_bytes": page * pages.get("Pages occupied by compressor", 0)}
            boot = subprocess.check_output(["/usr/sbin/sysctl", "-n", "kern.boottime"], text=True, timeout=3)
            result["uptime_seconds"] = max(0, time.time() - int(re.search(r"sec = (\d+)", boot).group(1)))
            swap = subprocess.check_output(["/usr/sbin/sysctl", "-n", "vm.swapusage"], text=True, timeout=3)
            for key, field in [("total", "total_bytes"), ("used", "used_bytes")]:
                match = re.search(key + r" = ([\d.]+)([KMG])", swap)
                if match:
                    result["swap"][field] = int(float(match.group(1)) * 1024 ** {"K": 1, "M": 2, "G": 3}[match.group(2)])
        else:
            errors.append("CPU/RAM sampling is implemented for Linux and macOS only")
    except (OSError, ValueError, AttributeError, KeyError, subprocess.SubprocessError) as e:
        errors.append("OS metric sampling incomplete: " + type(e).__name__)
    for root in config["roots"]:
        try:
            disk = shutil.disk_usage(root)
            result["disks"].append({"path": root, "total_bytes": disk.total, "used_bytes": disk.used, "free_bytes": disk.free})
        except OSError:
            errors.append("Disk metric unavailable for an enrolled root")
    if result["memory"].get("total_bytes"):
        result["memory"]["used_percent"] = round(100 * result["memory"]["used_bytes"] / result["memory"]["total_bytes"], 2)
    result["errors"] = errors
    return result


def save(path, value):
    target = Path(path)
    tmp = target.with_name(target.name + ".new-" + str(os.getpid()))
    with open(tmp, "w", encoding="utf-8") as f:
        os.chmod(tmp, 0o600)
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, target)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def denied(part):
    return part in DENIED or part.startswith(".env.") or part.endswith((".pem", ".key", ".p12"))


def path_parts(config, path):
    if not os.path.isabs(path):
        path = os.path.join(config["roots"][0], path)
    # Reject traversal instead of silently normalizing it away.
    if ".." in Path(path).parts:
        raise ValueError("Parent traversal is not allowed")
    for root in config["roots"]:
        if os.path.commonpath([root, path]) == root:
            parts = Path(os.path.relpath(path, root)).parts
            if any(denied(p) for p in parts):
                raise ValueError("Secret path refused; do not retrieve credentials through this connector")
            return root, parts
    raise ValueError("Path is outside the enrolled roots")


@contextlib.contextmanager
def parent_fd(config, path):
    root, parts = path_parts(config, path)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        yield fd, parts[-1] if parts else "."
    finally:
        os.close(fd)


def read_bytes(config, path, limit=MAX_FILE, offset=0):
    with parent_fd(config, path) as (parent, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, "rb") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise ValueError("Not a regular file")
            f.seek(offset)
            return f.read(limit)


def file_action(config, kind, a):
    path = a["path"]
    if kind == "fs_read":
        offset, limit = max(0, int(a.get("offset", 0))), min(32768, int(a.get("limit", 16000)))
        data = read_bytes(config, path, limit + 1, offset)
        return {"text": data[:limit].decode("utf-8", errors="replace"), "offset": offset,
                "next_offset": offset + min(len(data), limit), "has_more": len(data) > limit}
    if kind == "fs_search":
        matches, scanned, todo = [], 0, [path]
        deadline = time.monotonic() + 8
        while todo and scanned < 3000 and len(matches) < 100 and time.monotonic() < deadline:
            current = todo.pop()
            with parent_fd(config, current) as (p, n):
                fd = os.open(n, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=p)
                try:
                    for entry in os.listdir(fd):
                        if denied(entry) or entry in SKIP:
                            continue
                        scanned += 1
                        if scanned > 3000 or len(matches) >= 100 or time.monotonic() >= deadline:
                            break
                        info = os.stat(entry, dir_fd=fd, follow_symlinks=False)
                        child = os.path.join(current, entry)
                        if stat.S_ISLNK(info.st_mode):
                            continue
                        if stat.S_ISDIR(info.st_mode):
                            todo.append(child)
                        elif stat.S_ISREG(info.st_mode):
                            try:
                                if a.get("content") and info.st_size <= MAX_FILE:
                                    # Return locations, not potentially secret matching lines.
                                    text = read_bytes(config, child).decode("utf-8")
                                    lines = [i + 1 for i, line in enumerate(text.splitlines()) if a["query"] in line][:20]
                                    if lines:
                                        matches.append({"path": child, "lines": lines})
                                elif not a.get("content") and a["query"].lower() in entry.lower():
                                    matches.append({"path": child})
                            except (UnicodeError, OSError):
                                pass
                finally:
                    os.close(fd)
        return {"matches": matches, "scanned": scanned, "bounded": bool(todo) or scanned >= 3000 or len(matches) >= 100}
    with parent_fd(config, path) as (p, n):
        if kind == "fs_stat":
            s = os.stat(n, dir_fd=p, follow_symlinks=False)
            if stat.S_ISLNK(s.st_mode):
                raise ValueError("Symlink refused")
            return {"size": s.st_size, "mtime": s.st_mtime, "directory": stat.S_ISDIR(s.st_mode), "mode": oct(stat.S_IMODE(s.st_mode))}
        if kind == "fs_list":
            fd = os.open(n, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=p)
            try:
                entries = sorted(x for x in os.listdir(fd) if not denied(x))
                return {"entries": entries[:500], "truncated": len(entries) > 500}
            finally:
                os.close(fd)
        if kind in {"fs_write", "fs_edit"}:
            if kind == "fs_edit":
                raw = read_bytes(config, path, MAX_FILE + 1)
                if len(raw) > MAX_FILE:
                    raise ValueError("Edit size limit exceeded")
                old = raw.decode("utf-8")
                if not a["old_text"] or old.count(a["old_text"]) != 1:
                    raise ValueError("old_text must match exactly once")
                text = old.replace(a["old_text"], a["new_text"], 1)
            else:
                text = a["text"]
            # Atomic replacement avoids truncating an existing file on write failure,
            # and replaces rather than follows a hard link or symlink.
            mode = 0o600
            try:
                info = os.stat(n, dir_fd=p, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("Destination is not a regular file")
                if kind == "fs_write" and not a.get("overwrite", False):
                    raise ValueError("File exists; overwrite was not approved")
                mode = stat.S_IMODE(info.st_mode)
            except FileNotFoundError:
                if kind == "fs_edit":
                    raise
            tmp = ".siso-write-" + uuid.uuid4().hex
            try:
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=p)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(text)
                    f.flush()
                    os.fsync(f.fileno())
                if kind == "fs_write" and not a.get("overwrite", False):
                    os.link(tmp, n, src_dir_fd=p, dst_dir_fd=p, follow_symlinks=False)
                    os.unlink(tmp, dir_fd=p)
                else:
                    os.replace(tmp, n, src_dir_fd=p, dst_dir_fd=p)
            finally:
                try:
                    os.unlink(tmp, dir_fd=p)
                except FileNotFoundError:
                    pass
            return {"path": path, "bytes": len(text.encode("utf-8"))}
    raise ValueError("Unsupported file operation")


def task_dir(config, job_id):
    if str(uuid.UUID(job_id)) != job_id:
        raise ValueError("Invalid job id")
    return Path(config["state_dir"]) / "jobs" / job_id


def identity(pid):
    r = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def shell(config, directory, a):
    path_parts(config, a["cwd"])
    cwd = os.path.realpath(a["cwd"])
    path_parts(config, cwd)
    env = {"HOME": str(Path.home()), "PATH": config.get("path", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"),
           "LANG": "en_US.UTF-8", "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen(["/bin/bash", "-c", a["command"]], cwd=cwd, env=env,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    save(directory / "process.json", {"pid": proc.pid, "supervisor_pid": os.getpid(), "started": time.time(), "cwd": cwd})
    sel = selectors.DefaultSelector()
    sizes = {"stdout": 0, "stderr": 0}
    files = {k: open(directory / (k + ".log"), "wb", buffering=0) for k in sizes}
    for stream, name in [(proc.stdout, "stdout"), (proc.stderr, "stderr")]:
        os.set_blocking(stream.fileno(), False)
        sel.register(stream, selectors.EVENT_READ, name)
    deadline = time.monotonic() + min(604800, max(1, a.get("timeout_seconds", 3600)))
    status = "completed"
    killed = False
    try:
        while sel.get_map() or proc.poll() is None:
            if not killed and ((directory / "cancel").exists() or time.monotonic() >= deadline):
                status = "cancelled" if (directory / "cancel").exists() else "timed_out"
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                killed = True
            for key, _ in sel.select(0.2):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    sel.unregister(key.fileobj)
                    key.fileobj.close()
                else:
                    remaining = max(0, MAX_LOG - sizes[key.data])
                    files[key.data].write(data[:remaining])
                    sizes[key.data] += len(data)
        code = proc.wait()
        if status == "completed" and code != 0:
            status = "failed"
    finally:
        sel.close()
        for f in files.values():
            os.fsync(f.fileno())
            f.close()
    result = {"exit_code": code, "pid": proc.pid, "supervisor_pid": os.getpid(), "log_bytes": sizes,
              "logs_truncated": any(v > MAX_LOG for v in sizes.values())}
    for name in files:
        with open(directory / (name + ".log"), "rb") as f:
            f.seek(max(0, min(sizes[name], MAX_LOG) - 4000))
            result[name + "_tail"] = f.read(4000).decode("utf-8", errors="replace")
    return status, result


def run_task(config, job_id):
    directory = task_dir(config, job_id)
    task = load(directory / "request.json")
    save(directory / "supervisor.json", {"pid": os.getpid(), "identity": identity(os.getpid())})
    try:
        kind, a = task["kind"], task["args"]
        if kind in {"shell_exec", "job_start"}:
            status, result = shell(config, directory, a)
        elif kind == "node_metrics":
            status, result = "completed", metrics(config)
        elif kind.startswith("fs_"):
            status, result = "completed", file_action(config, kind, a)
        elif kind in {"job_logs", "job_cancel"}:
            target = task_dir(config, a["job_id"])
            if not target.is_dir():
                raise ValueError("Job not known to this node")
            if kind == "job_cancel":
                (target / "cancel").touch(mode=0o600)
                result = {"cancellation_requested": True, "job_id": a["job_id"]}
            else:
                stream = a.get("stream", "stdout")
                if stream not in {"stdout", "stderr"}:
                    raise ValueError("Invalid stream")
                offset, limit = max(0, int(a.get("offset", 0))), min(32768, max(1, int(a.get("limit", 16000))))
                with open(target / (stream + ".log"), "rb") as f:
                    f.seek(offset)
                    data = f.read(limit)
                    total = os.fstat(f.fileno()).st_size
                result = {"text": data.decode("utf-8", errors="replace"), "offset": offset, "next_offset": offset + len(data), "total_bytes": total}
            status = "completed"
        else:
            raise ValueError("Unsupported operation")
    except Exception as e:
        status, result = "failed", {"error": str(e)}
    save(directory / "result.json", {"id": job_id, "status": status, "result": result})


def daemon(config, config_path):
    jobs = Path(config["state_dir"]) / "jobs"
    jobs.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Single writer per node, held across all polls.
    import fcntl
    lock = open(Path(config["state_dir"]) / "agent.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    gateway = config["gateway"]
    if not gateway.startswith("https://") and not gateway.startswith("http://127.0.0.1:"):
        raise ValueError("Gateway must use HTTPS or loopback")
    cursor = 0
    while True:
        try:
            reports, running, active = [], [], 0
            for d in jobs.iterdir():
                if not d.is_dir() or (d / "ack").exists():
                    continue
                if (d / "result.json").exists():
                    if not reports:
                        reports.append(load(d / "result.json"))
                    continue
                request_kind = load(d / "request.json")["kind"]
                active += int(request_kind in {"shell_exec", "job_start"})
                if not (d / "supervisor.json").exists():
                    # Never replay an ambiguous start: allow launch grace, then expose interruption.
                    alive = time.time() - d.stat().st_mtime < 15
                else:
                    supervisor = load(d / "supervisor.json")
                    alive = bool(supervisor["identity"]) and identity(supervisor["pid"]) == supervisor["identity"]
                if not alive:
                    save(d / "result.json", {"id": d.name, "status": "interrupted", "result": {"error": "Supervisor absent after restart/reboot; not automatically replayed"}})
                else:
                    result = load(d / "process.json") if (d / "process.json").exists() else {}
                    running.append({"id": d.name, "status": "running", "result": result})
            if not reports and running:
                reports = [running[cursor % len(running)]]
                cursor += 1
            payload = {"info": {"hostname": socket.gethostname(), "roots": config["roots"], "agent_version": AGENT_VERSION}, "reports": reports,
                       "capacity": max(0, min(1, 4 - active))}
            if len(json.dumps(payload).encode()) > 90000:
                reports[0]["status"] = "failed"
                reports[0]["result"] = {"error": "Result exceeds transport budget; refine the query or request a smaller page"}
            request = urllib.request.Request(gateway.rstrip("/") + "/fleet/poll/" + config["node"],
                data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + config["token"], "Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=15) as r:
                response = json.load(r)
            for job_id in response["ack"]:
                (task_dir(config, job_id) / "ack").touch(mode=0o600)
            for task in response["tasks"]:
                d = task_dir(config, task["id"])
                d.mkdir(mode=0o700)  # Existing id is never executed twice.
                save(d / "request.json", task)
                subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--config", str(config_path), "--run", task["id"]],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True, close_fds=True)
            time.sleep(0.5)
        except Exception as e:
            # No request bodies, URLs containing credentials, or token values in logs.
            print("node_poll_error", type(e).__name__, flush=True)
            time.sleep(3)


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--run")
    args = parser.parse_args()
    cfg = load(args.config)
    if not cfg.get("roots") or any(not os.path.isabs(r) or os.path.realpath(r) != r for r in cfg["roots"]):
        raise ValueError("Explicit canonical roots required")
    if args.run:
        run_task(cfg, args.run)
    else:
        daemon(cfg, args.config.resolve())
