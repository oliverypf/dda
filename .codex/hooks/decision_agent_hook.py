"""Load the maintained Decision-Driven Agent hook for hmCodex on Windows."""

from __future__ import annotations

import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = Path(r"C:\Users\User\decision_driven_agent")
if not (SOURCE_ROOT / "decision_agent" / "codex_hook.py").is_file():
    raise RuntimeError(f"Decision-Driven Agent source is unavailable: {SOURCE_ROOT}")
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

# Bind the project hook to this checkout's configuration even when Codex runs
# the hook with a different working directory.
CONFIG = PROJECT_ROOT / "jev.config.json"
if CONFIG.is_file():
    os.environ["DECISION_AGENT_CONFIG"] = str(CONFIG)

from decision_agent.codex_hook import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(root_dir=PROJECT_ROOT))
