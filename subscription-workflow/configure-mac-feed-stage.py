import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path


os.umask(0o077)
home = Path.home()
project = home / "Agent/Projects/progressive-reading-workflow"
runtime = home / "Agent/AppData/ProgressiveReading/SubscriptionFeedCapture"
label = "org.memoedu.progressive-reading.rss-capture"
domain = f"gui/{os.getuid()}"
cli = "/bin/launchctl"
agent = home / "Library/LaunchAgents" / (label + ".plist")
node = home / ".local/bin/node"
script = project / "subscription-workflow/remote-feed-stage.mjs"


def main():
    registry = Path(sys.argv[1])
    config = json.loads(registry.read_text())
    if not config["enabled"]:
        raise ValueError("RSS registry is disabled")
    if config["schedule"]["rss"] != "06:00" or config["schedule"]["timezone"] != "Asia/Shanghai":
        raise ValueError("RSS calendar must match the current registry")
    if agent.exists():
        raise FileExistsError(agent)
    runtime.mkdir(parents=True, exist_ok=True)
    plan = runtime / "registry.json"
    plan.write_text(json.dumps({
        "enabled": True,
        "revision": config["revision"],
        "subscriptions": [
            {key: source[key] for key in ("id", "url", "kind", "enabled")}
            for source in config["subscriptions"] if source["enabled"] and source["kind"] == "rss"
        ]
    }))
    candidate = agent.with_suffix(".staging")
    with candidate.open("xb") as stream:
        plistlib.dump({
            "Label": label,
            "ProgramArguments": [str(node), str(script), "run", str(runtime), str(plan)],
            "StartCalendarInterval": {"Hour": 6, "Minute": 0},
            "WorkingDirectory": str(project),
            "EnvironmentVariables": {"TZ": "Asia/Shanghai"},
            "StandardOutPath": str(runtime / "launchd.stdout"),
            "StandardErrorPath": str(runtime / "launchd.stderr"),
            "Umask": 0o077,
        }, stream)
    subprocess.run(["/usr/bin/plutil", "-lint", candidate], check=True)
    candidate.rename(agent)
    subprocess.run([cli, "bootstrap", domain, agent], check=True)
    print(f"Installed {domain}/{label}")


if __name__ == "__main__":
    main()
