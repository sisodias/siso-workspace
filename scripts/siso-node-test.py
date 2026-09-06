#!/usr/bin/env python3
"""Narrow, self-cleaning fixture; never runs in a real workspace."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location("node", Path(__file__).with_name("siso-node.py"))
node = importlib.util.module_from_spec(spec)
spec.loader.exec_module(node)


class NodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = Path(sys.argv[1]).resolve()
        cls.root = cls.base / "workspace"
        cls.root.mkdir()
        cls.state = cls.base / "state"
        (cls.state / "jobs").mkdir(parents=True)
        cls.config = {"roots": [str(cls.root)], "state_dir": str(cls.state)}
        cls.config_path = cls.base / "node.json"
        node.save(cls.config_path, cls.config)

    def test_files(self):
        a = {"path": str(self.root / "hello.txt"), "text": "hello world"}
        self.assertEqual(node.file_action(self.config, "fs_write", a)["bytes"], 11)
        with self.assertRaises(ValueError):
            node.file_action(self.config, "fs_write", a)
        node.file_action(self.config, "fs_edit", {"path": a["path"], "old_text": "world", "new_text": "fleet"})
        self.assertEqual(node.file_action(self.config, "fs_read", a)["text"], "hello fleet")
        self.assertTrue(node.file_action(self.config, "fs_search", {"path": str(self.root), "query": "fleet", "content": True})["matches"])

    def test_boundaries(self):
        secret = self.base / "private.txt"
        secret.write_text("do not read")
        (self.root / "escape").symlink_to(secret)
        (self.root / ".env").write_text("SECRET=hidden")
        for path in [str(secret), str(self.root / "escape"), str(self.root / "../private.txt"), str(self.root / ".env")]:
            with self.assertRaises((ValueError, OSError)):
                node.file_action(self.config, "fs_read", {"path": path})
        with self.assertRaises(ValueError):
            node.task_dir(self.config, "../../private")

    def execute(self, command, timeout=5, cancel=False):
        job = str(uuid.uuid4())
        directory = node.task_dir(self.config, job)
        directory.mkdir()
        node.save(directory / "request.json", {"id": job, "kind": "job_start", "args": {"cwd": str(self.root), "command": command, "timeout_seconds": timeout}})
        p = subprocess.Popen([sys.executable, str(Path(__file__).with_name("siso-node.py")), "--config", str(self.config_path), "--run", job], start_new_session=True)
        if cancel:
            time.sleep(0.3)
            (directory / "cancel").touch()
        p.wait(timeout=10)
        return node.load(directory / "result.json"), directory

    def test_shell_output(self):
        r, d = self.execute("printf 'stdout-proof'; printf 'stderr-proof' >&2; exit 7")
        self.assertEqual(r["status"], "failed")
        self.assertEqual(r["result"]["exit_code"], 7)
        self.assertEqual((d / "stdout.log").read_text(), "stdout-proof")
        self.assertEqual((d / "stderr.log").read_text(), "stderr-proof")

    def test_timeout(self):
        r, _ = self.execute("sleep 60", timeout=1)
        self.assertEqual(r["status"], "timed_out")

    def test_cancel(self):
        r, _ = self.execute("sleep 60", cancel=True)
        self.assertEqual(r["status"], "cancelled")

    def test_metrics(self):
        result = node.metrics(self.config)
        self.assertEqual(result["errors"], [])
        self.assertGreater(result["memory"]["total_bytes"], 0)
        self.assertLessEqual(result["memory"]["available_bytes"], result["memory"]["total_bytes"])
        self.assertTrue(0 <= result["cpu"]["utilization_percent"] <= 100)
        self.assertGreater(result["disks"][0]["free_bytes"], 0)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
