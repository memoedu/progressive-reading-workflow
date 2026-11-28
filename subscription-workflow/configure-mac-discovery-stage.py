import datetime
import json
import os
import plistlib
import subprocess
import sys
from pathlib import Path


def main():
    os.umask(0o077)
    hours = {"zhihu": 7, "bilibili": 8}
    kind, = sys.argv[1:]
    hour = hours[kind]
    if datetime.datetime.now().astimezone().utcoffset() != datetime.timedelta(hours=8):
        raise ValueError("The login session calendar must use UTC+08:00")

    home = Path.home()
    project = home / "Agent/Projects/progressive-reading-workflow"
    app_data = home / "Agent/AppData"
    runtime = app_data / "ProgressiveReading/SubscriptionDiscoveryCapture"
    node = home / ".local/bin/node"
    script = project / "subscription-workflow/remote-discovery-capture.mjs"
    label = f"org.memoedu.progressive-reading.{kind}-capture"
    agent = home / "Library/LaunchAgents" / (label + ".plist")
    domain = f"gui/{os.getuid()}"
    registry = json.loads((runtime / "registry.json").read_text())
    if not registry["enabled"] or not registry[kind]:
        raise ValueError("The configured source capture is inactive")
    if agent.exists():
        raise FileExistsError(agent)

    candidate = agent.with_suffix(".staging")
    with candidate.open("xb") as stream:
        plistlib.dump({
            "Label": label,
            "ProgramArguments": [str(node), str(script), "run", str(runtime), kind],
            "StartCalendarInterval": {"Hour": hour, "Minute": 0},
            "WorkingDirectory": str(project),
            "EnvironmentVariables": {"TZ": "Asia/Shanghai", "PROGRESSIVE_READING_DATA_HOME": str(app_data)},
            "StandardOutPath": str(runtime / (kind + ".stdout")),
            "StandardErrorPath": str(runtime / (kind + ".stderr")),
            "Umask": 0o077,
        }, stream)
    try:
        subprocess.run(["/usr/bin/plutil", "-lint", candidate], check=True)
        candidate.rename(agent)
        try:
            subprocess.run(["/bin/launchctl", "bootstrap", domain, agent], check=True)
        except subprocess.CalledProcessError:
            agent.rename(candidate)
            raise
    finally:
        if candidate.exists():
            candidate.unlink()
    print(f"Installed {domain}/{label} at {hour:02}:00")


if __name__ == "__main__":
    main()
