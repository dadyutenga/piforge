"""Non-disruptive NetworkManager checkpoint API probe on the target Pi."""

import os
import re

import paramiko


password = os.environ["PIFORGE_SSH_PASSWORD"]
client = paramiko.SSHClient()
client.load_host_keys(os.path.expanduser("~/.ssh/known_hosts"))
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(os.environ.get("PIFORGE_SSH_HOST", "10.0.0.56"), username="dadi", password=password)


def sudo(command):
    stdin, stdout, stderr = client.exec_command("sudo -S -p '' " + command)
    stdin.write(password + "\n")
    stdin.flush()
    result = stdout.read().decode().strip()
    error = stderr.read().decode().strip()
    code = stdout.channel.recv_exit_status()
    if code:
        raise RuntimeError(f"{command}: {error or result}")
    return result


try:
    path = sudo("nmcli -g GENERAL.DBUS-PATH device show wlan0").strip()
    base = "busctl call org.freedesktop.NetworkManager /org/freedesktop/NetworkManager org.freedesktop.NetworkManager "
    result = sudo(base + "CheckpointCreate aouu 1 " + path + " 15 2")
    match = re.search(r"/org/freedesktop/NetworkManager/Checkpoint/[0-9]+", result)
    if not match:
        raise RuntimeError("CheckpointCreate did not return a checkpoint path")
    sudo(base + "CheckpointDestroy o " + match.group())
    print("NetworkManager checkpoint create/destroy succeeded without changing Wi-Fi")
finally:
    client.close()
