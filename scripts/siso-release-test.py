#!/usr/bin/env python3
"""Disposable local-only activation/rollback probe; no real services or credentials."""
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tarfile

root = Path(sys.argv[1]) / "release-fixture"
root.mkdir()
scripts = Path(__file__).resolve().parent

def archive(name, symlink=False):
    target = root / (name + ".tar.gz")
    with tarfile.open(target, "w:gz") as tar:
        for path in ["scripts/siso-node.py", "SKILL.md"]:
            data = name.encode()
            member = tarfile.TarInfo(path)
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
        if symlink:
            member = tarfile.TarInfo("scripts/escape")
            member.type = tarfile.SYMTYPE
            member.linkname = "/etc/passwd"
            tar.addfile(member)
    return target, hashlib.sha256(target.read_bytes()).hexdigest()

def install(path, sha):
    return subprocess.run([sys.executable, str(scripts / "siso-install-release.py"), str(path), sha, str(root / "runtime"), "node"], capture_output=True, text=True)

first, first_sha = archive("first")
assert install(first, first_sha).returncode == 0
before = (root / "runtime/current").resolve()
assert install(first, "0" * 64).returncode != 0
bad, bad_sha = archive("bad-link", symlink=True)
assert install(bad, bad_sha).returncode != 0
assert (root / "runtime/current").resolve() == before
second, second_sha = archive("second")
inventory = root / "inventory.json"
inventory.write_text(json.dumps({"targets": [{"id": "fixture", "expectedHost": socket.gethostname(), "role": "node", "python": sys.executable,
    "runtimeRoot": str(root / "runtime"), "stagingDir": str(root / "staging"), "restart": [], "check": ["false"]}]}))
roll = subprocess.run(["node", str(scripts / "siso-rollout.mjs"), str(second), str(inventory), "--apply"], capture_output=True, text=True)
assert roll.returncode != 0
assert (root / "runtime/current").resolve() == before, "Failed check did not restore prior release"
print("PASS release hash and symlink rejection; failing health check restores prior current pointer")
