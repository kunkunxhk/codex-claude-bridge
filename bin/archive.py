"""Write the supplied source allowlist as a deterministic, relocatable ZIP."""
import json
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1]).resolve()
target = Path(sys.argv[2]).resolve()
files = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for relative in files:
        source = (root / relative).resolve()
        if not source.is_relative_to(root) or not source.is_file():
            raise ValueError("Invalid archive source: " + relative)
        info = zipfile.ZipInfo("codex-claude-bridge/" + relative)
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, source.read_bytes())
