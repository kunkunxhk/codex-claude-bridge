"""Launch the native CLI in a real Windows console, without redirected stdio."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if os.name != "nt":
    raise RuntimeError("Visible launch currently supports Windows only")
if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", plan["sessionId"]):
    raise ValueError("Invalid session ID")
if not re.fullmatch(r"codex-task-[a-fA-F0-9]{8}", plan["name"]):
    raise ValueError("Invalid terminal name")
process = subprocess.Popen(
    [plan["executable"], "--session-id", plan["sessionId"], "--name", plan["name"]],
    cwd=plan["cwd"],
    creationflags=subprocess.CREATE_NEW_CONSOLE | subprocess.CREATE_NEW_PROCESS_GROUP,
    close_fds=True,
)
print(json.dumps({"pid": process.pid, "terminal": "native-console", "name": plan["name"]}))
