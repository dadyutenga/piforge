"""Check NetworkManager can create a protected inactive profile, then delete it."""

import os
import secrets

import paramiko


password = os.environ["PIFORGE_SSH_PASSWORD"]
name = "PiForge-probe-" + secrets.token_hex(4)
client = paramiko.SSHClient()
client.load_host_keys(os.path.expanduser("~/.ssh/known_hosts"))
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(os.environ.get("PIFORGE_SSH_HOST", "10.0.0.56"), username="dadi", password=password)


def sudo(command):
    stdin, stdout, stderr = client.exec_command("sudo -S -p '' " + command)
    stdin.write(password + "\n")
    stdin.flush()
    output = stdout.read().decode().strip()
    error = stderr.read().decode().strip()
    code = stdout.channel.recv_exit_status()
    if code:
        raise RuntimeError(error or output)
    return output


try:
    sudo(f"nmcli connection add type wifi ifname wlan0 con-name {name} ssid PiForge-Probe connection.autoconnect no wifi-sec.key-mgmt wpa-psk")
    print("Protected inactive Wi-Fi profile creation succeeded")
finally:
    try:
        sudo(f"nmcli connection delete id {name}")
    finally:
        client.close()
