"""Submit a decision-space packet through the maintained source package."""
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = Path(r"C:\Users\User\decision_driven_agent")
if not (SOURCE_ROOT / "decision_agent" / "direction.py").is_file():
    raise RuntimeError(f"Decision-Driven Agent source is unavailable: {SOURCE_ROOT}")
sys.path.insert(0, str(SOURCE_ROOT))
config = PROJECT_ROOT / "jev.config.json"
if config.is_file():
    os.environ["DECISION_AGENT_CONFIG"] = str(config)

from decision_agent.direction import main

if __name__ == "__main__":
    main()
