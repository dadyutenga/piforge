"""End-to-end safe Wi-Fi mutation test: forget an inactive disposable profile."""

import http.cookiejar
import json
import os
import secrets
import ssl
import urllib.error
import urllib.request

import paramiko


host = os.environ.get("PIFORGE_SSH_HOST", "10.0.0.56")
ssh_password = os.environ["PIFORGE_SSH_PASSWORD"]
admin_password = os.environ["PIFORGE_TEST_PASSWORD"]
name = "PiForge-probe-" + secrets.token_hex(4)
client = paramiko.SSHClient()
client.load_host_keys(os.path.expanduser("~/.ssh/known_hosts"))
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(host, username="dadi", password=ssh_password)


def sudo(command):
    stdin, stdout, stderr = client.exec_command("sudo -S -p '' " + command)
    stdin.write(ssh_password + "\n")
    stdin.flush()
    output = stdout.read().decode().strip()
    error = stderr.read().decode().strip()
    code = stdout.channel.recv_exit_status()
    if code:
        raise RuntimeError(error or output)
    return output


cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(cookies),
    urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
)
origin = "https://" + host + ":8787"


def post(path, data, csrf=""):
    headers = {"Content-Type": "application/json"}
    if csrf:
        headers["X-CSRF-Token"] = csrf
    request = urllib.request.Request(origin + path, data=json.dumps(data).encode(), headers=headers, method="POST")
    with opener.open(request, timeout=15) as response:
        return json.load(response)


try:
    sudo(f"nmcli connection add type wifi ifname wlan0 con-name {name} ssid PiForge-Probe connection.autoconnect no wifi.hidden yes")
    uuid = sudo(f"nmcli -g connection.uuid connection show id {name}")
    session = post("/api/login", {"username": "dadi", "password": admin_password})
    result = post("/api/wifi/forget", {"uuid": uuid}, session["csrf"])
    if not result.get("ok"):
        raise RuntimeError("PiForge did not confirm profile deletion")
    _, stdout, _ = client.exec_command(f"nmcli -g connection.uuid connection show uuid {uuid}")
    stdout.read()
    if stdout.channel.recv_exit_status() == 0:
        raise RuntimeError("Profile still exists after PiForge forget")
    print("PiForge forgot an inactive test Wi-Fi profile; current connection was untouched")
finally:
    try:
        sudo(f"nmcli connection delete id {name}")
    except RuntimeError:
        pass
    client.close()
