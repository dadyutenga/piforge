"""Install a built PiForge release on the Pi over SSH.

Set PIFORGE_SSH_PASSWORD and run after building dist/piforge. The script
installs a non-root systemd service with a self-signed LAN certificate.
"""

import os
from pathlib import Path
import posixpath
import shlex
import time

import paramiko


ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("PIFORGE_SSH_HOST", "10.0.0.56")
PASSWORD = os.environ["PIFORGE_SSH_PASSWORD"]
REMOTE = "/home/dadi/piforge-app"
TLS = "/home/dadi/.local/share/piforge/tls"


def run(client, command, sudo=False):
    if sudo:
        command = "sudo -S -p '' " + command
    stdin, stdout, stderr = client.exec_command(command, timeout=45)
    if sudo:
        stdin.write(PASSWORD + "\n")
        stdin.flush()
    status = stdout.channel.recv_exit_status()
    output = stdout.read().decode().strip()
    error = stderr.read().decode().strip()
    if status:
        raise RuntimeError(f"Remote command failed ({status}): {error or output}")
    return output


client = paramiko.SSHClient()
client.load_host_keys(os.path.expanduser("~/.ssh/known_hosts"))
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(HOST, username="dadi", password=PASSWORD, timeout=10)
try:
    files = [path for path in (ROOT / "web").rglob("*") if path.is_file()]
    directories = {posixpath.dirname(posixpath.join(REMOTE, "static", path.relative_to(ROOT / "web").as_posix())) for path in files}
    directories.update([REMOTE, "/home/dadi/PiForge", TLS])
    run(client, "mkdir -p " + " ".join(shlex.quote(directory) for directory in sorted(directories)))
    sftp = client.open_sftp()
    sftp.put(str(ROOT / "dist" / "piforge"), REMOTE + "/piforge.next")
    sftp.chmod(REMOTE + "/piforge.next", 0o755)
    sftp.put(str(ROOT / "dist" / "piforge-wifi-helper"), REMOTE + "/piforge-wifi-helper.next")
    sftp.put(str(ROOT / "dist" / "piforge-bluetooth-helper"), REMOTE + "/piforge-bluetooth-helper.next")
    for source in files:
        target = posixpath.join(REMOTE, "static", source.relative_to(ROOT / "web").as_posix())
        sftp.put(str(source), target)
    sftp.put(str(ROOT / "deployments" / "systemd" / "piforge.service"), REMOTE + "/piforge.service")
    sftp.put(str(ROOT / "deployments" / "systemd" / "piforge-wifi-helper.service"), REMOTE + "/piforge-wifi-helper.service")
    sftp.put(str(ROOT / "deployments" / "systemd" / "piforge-bluetooth-helper.service"), REMOTE + "/piforge-bluetooth-helper.service")
    run(client, f"mv {shlex.quote(REMOTE)}/piforge.next {shlex.quote(REMOTE)}/piforge")
    run(client, f"mv {shlex.quote(REMOTE)}/piforge-wifi-helper.next {shlex.quote(REMOTE)}/piforge-wifi-helper")
    run(client, f"mv {shlex.quote(REMOTE)}/piforge-bluetooth-helper.next {shlex.quote(REMOTE)}/piforge-bluetooth-helper")
    cert = TLS + "/server.crt"
    key = TLS + "/server.key"
    if run(client, f"test -f {shlex.quote(cert)} && echo yes || echo no") == "no":
        hostname = run(client, "hostname").strip()
        alt = f"subjectAltName=IP:{HOST},DNS:{hostname}.local"
        run(client, "openssl req -x509 -newkey rsa:2048 -nodes -days 365 "
            f"-keyout {shlex.quote(key)} -out {shlex.quote(cert)} "
            f"-subj {shlex.quote('/CN=' + hostname + '.local')} -addext {shlex.quote(alt)}")
        run(client, f"chmod 600 {shlex.quote(key)}; chmod 644 {shlex.quote(cert)}")
    run(client, "pids=$(pgrep -u dadi -f '^\\./piforge$|^/home/dadi/piforge-dev/piforge$' || true); if [ -n \"$pids\" ]; then kill $pids; fi")
    time.sleep(2)
    run(client, "install -d -m 0755 /usr/local/libexec", sudo=True)
    run(client, f"install -m 0644 {shlex.quote(REMOTE)}/piforge.service /etc/systemd/system/piforge.service", sudo=True)
    run(client, f"install -m 0755 -o root -g root {shlex.quote(REMOTE)}/piforge-wifi-helper /usr/local/libexec/piforge-wifi-helper.next", sudo=True)
    run(client, "mv /usr/local/libexec/piforge-wifi-helper.next /usr/local/libexec/piforge-wifi-helper", sudo=True)
    run(client, f"install -m 0644 {shlex.quote(REMOTE)}/piforge-wifi-helper.service /etc/systemd/system/piforge-wifi-helper.service", sudo=True)
    run(client, f"install -m 0755 -o root -g root {shlex.quote(REMOTE)}/piforge-bluetooth-helper /usr/local/libexec/piforge-bluetooth-helper.next", sudo=True)
    run(client, "mv /usr/local/libexec/piforge-bluetooth-helper.next /usr/local/libexec/piforge-bluetooth-helper", sudo=True)
    run(client, f"install -m 0644 {shlex.quote(REMOTE)}/piforge-bluetooth-helper.service /etc/systemd/system/piforge-bluetooth-helper.service", sudo=True)
    run(client, "systemctl daemon-reload", sudo=True)
    run(client, "systemctl enable piforge-wifi-helper.service", sudo=True)
    run(client, "systemctl restart piforge-wifi-helper.service", sudo=True)
    run(client, "systemctl enable piforge-bluetooth-helper.service", sudo=True)
    run(client, "systemctl restart piforge-bluetooth-helper.service", sudo=True)
    run(client, "systemctl enable piforge.service", sudo=True)
    run(client, "systemctl restart piforge.service", sudo=True)
    print("Wi-Fi helper:", run(client, "systemctl is-active piforge-wifi-helper.service"))
    print("Bluetooth helper:", run(client, "systemctl is-active piforge-bluetooth-helper.service"))
    print("PiForge:", run(client, "systemctl is-active piforge.service"))
    print(f"PiForge installed at https://{HOST}:8787 (self-signed certificate).")
finally:
    client.close()
