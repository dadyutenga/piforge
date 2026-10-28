"""Copy a development build to the Raspberry Pi over SSH and restart it.

Usage: set PIFORGE_SSH_PASSWORD, then run python scripts/stage-pi.py.
This stages a loopback-only HTTP server for SSH-tunnel testing.
"""

import os
from pathlib import Path
import posixpath
import shlex
import time

import paramiko


ROOT = Path(__file__).resolve().parents[1]
REMOTE = "/home/dadi/piforge-dev"
HOST = os.environ.get("PIFORGE_SSH_HOST", "10.0.0.56")
PASSWORD = os.environ["PIFORGE_SSH_PASSWORD"]


def run(client, command):
    _, stdout, stderr = client.exec_command(command, timeout=20)
    status = stdout.channel.recv_exit_status()
    if status:
        raise RuntimeError(f"Remote command failed ({status}): {stderr.read().decode().strip()}")
    return stdout.read().decode().strip()


client = paramiko.SSHClient()
client.load_host_keys(os.path.expanduser("~/.ssh/known_hosts"))
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(HOST, username="dadi", password=PASSWORD, timeout=10)
try:
    sftp = client.open_sftp()
    run(client, f"mkdir -p {shlex.quote(REMOTE)}/static")
    sftp.put(str(ROOT / "dist" / "piforge"), REMOTE + "/piforge.next")
    sftp.chmod(REMOTE + "/piforge.next", 0o755)
    for source in (ROOT / "web").rglob("*"):
        if not source.is_file():
            continue
        relative = source.relative_to(ROOT / "web").as_posix()
        target = posixpath.join(REMOTE, "static", relative)
        run(client, f"mkdir -p {shlex.quote(posixpath.dirname(target))}")
        sftp.put(str(source), target)
    run(client, f"mv {shlex.quote(REMOTE)}/piforge.next {shlex.quote(REMOTE)}/piforge")
    run(client, "pids=$(pgrep -u dadi -f '^\\./piforge$|^/home/dadi/piforge-dev/piforge$' || true); if [ -n \"$pids\" ]; then kill $pids; fi")
    time.sleep(2)
    run(client, f"nohup env PIFORGE_INSECURE_HTTP=1 PIFORGE_STATIC_DIR={shlex.quote(REMOTE)}/static {shlex.quote(REMOTE)}/piforge > {shlex.quote(REMOTE)}/server.log 2>&1 < /dev/null &")
    print(f"Staged at {REMOTE} on {HOST}; HTTP is loopback-only on port 8787.")
finally:
    client.close()
