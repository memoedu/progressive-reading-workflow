import datetime
import os
import plistlib
import subprocess
import sys
from pathlib import Path


def install(kind):
    calendars = {"daily": {"Hour": 9, "Minute": 0},
                 "weekly": {"Weekday": 0, "Hour": 21, "Minute": 0}}
    if datetime.datetime.now().astimezone().utcoffset() != datetime.timedelta(hours=8):
        raise ValueError("Report launchd calendar requires UTC+08:00")
    home = Path.home()
    project = home / "Agent/Projects/progressive-reading-workflow"
    runtime = home / "Agent/AppData/ProgressiveReading/SubscriptionReportDrafts"
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    node = home / ".local/bin/node"
    worker = project / "subscription-workflow/scheduled-report-draft.mjs"
    if not node.is_file() or not worker.is_file():
        raise FileNotFoundError("The checked-out draft worker and Node are required")
    label = f"org.memoedu.progressive-reading.{kind}-draft"
    agent = home / "Library/LaunchAgents" / (label + ".plist")
    if agent.exists():
        raise FileExistsError(agent)
    candidate = agent.with_suffix(".staging")
    with candidate.open("xb") as stream:
        plistlib.dump({
            "Label": label,
            "ProgramArguments": [str(node), str(worker), "run", str(runtime), kind],
            "StartCalendarInterval": calendars[kind],
            "WorkingDirectory": str(project),
            "EnvironmentVariables": {"TZ": "Asia/Shanghai"},
            "StandardOutPath": str(runtime / (kind + ".stdout")),
            "StandardErrorPath": str(runtime / (kind + ".stderr")),
            "Umask": 0o077,
        }, stream)
    domain = f"gui/{os.getuid()}"
    try:
        subprocess.run(["/usr/bin/plutil", "-lint", candidate], check=True)
        candidate.rename(agent)
        try:
            subprocess.run(["/bin/launchctl", "bootstrap", domain, agent], check=True)
        except subprocess.CalledProcessError:
            agent.rename(candidate)
            raise
    finally:
        candidate.unlink(missing_ok=True)
    print(f"Installed {domain}/{label}")


if __name__ == "__main__":
    os.umask(0o077)
    install(*sys.argv[1:])
