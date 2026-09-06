#!/usr/bin/env python3
"""Install an operator-selected, SHA-verified runtime; never touches private config/job state."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

archive, expected, directory, role = sys.argv[1:5]
if role not in {"gateway", "node"} or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
    raise ValueError("Invalid release arguments")
root = Path(directory).resolve()
if len(root.parts) < 3 or root == Path.home():
    raise ValueError("Explicit dedicated runtime directory required")
root.mkdir(parents=True, exist_ok=True)
lock = open(root / "install.lock", "a")
fcntl.flock(lock, fcntl.LOCK_EX)
with open(archive, "rb") as f:
    digest = hashlib.file_digest(f, "sha256").hexdigest()
if digest != expected:
    raise ValueError("Archive SHA-256 mismatch")
target = root / "releases" / expected[:16]
receipt = target / "installed.json"
if not receipt.exists():
    target.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, "r:gz") as tar:
        entries = tar.getmembers()
        if sum(m.size for m in entries) > 150 * 1024 * 1024:
            raise ValueError("Release exceeds size budget")
        for member in entries:
            p = Path(member.name)
            if p.is_absolute() or ".." in p.parts or not p.parts or p.parts[0] not in {"dist", "scripts", "SKILL.md", "package.json", "package-lock.json"}:
                raise ValueError("Unexpected archive member")
            if not member.isfile() and not member.isdir():
                raise ValueError("Links/devices are not accepted in releases")
        tar.extractall(target, filter="data")
    if role == "gateway":
        subprocess.run(["npm", "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=target, check=True, stdout=sys.stderr)
    receipt.write_text(json.dumps({"sha256": expected, "role": role}) + "\n")
elif json.loads(receipt.read_text()) != {"sha256": expected, "role": role}:
    raise ValueError("Existing release receipt differs")
current = root / "current"
if current.exists() and not current.is_symlink():
    raise ValueError("Refusing to replace a non-symlink current path")
previous = os.readlink(current) if current.is_symlink() else None
new = root / ("current.new-" + str(os.getpid()))
new.symlink_to(target.relative_to(root))
os.replace(new, current)
print(json.dumps({"current": str(current), "previous": previous, "sha256": expected}))
