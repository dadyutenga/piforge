"""Exercise the installed restricted helper without changing Wi-Fi."""

import os

import paramiko


client = paramiko.SSHClient()
client.load_host_keys(os.path.expanduser("~/.ssh/known_hosts"))
client.set_missing_host_key_policy(paramiko.RejectPolicy())
client.connect(os.environ.get("PIFORGE_SSH_HOST", "10.0.0.56"), username="dadi", password=os.environ["PIFORGE_SSH_PASSWORD"])
try:
    script = """import json, socket
s = socket.socket(socket.AF_UNIX)
s.connect('/run/piforge-helper/control.sock')
s.sendall(b'{"action":"probe"}\\n')
print(s.recv(4096).decode().strip())
s.close()
"""
    stdin, stdout, stderr = client.exec_command("python3 -")
    stdin.write(script)
    stdin.channel.shutdown_write()
    output = stdout.read().decode().strip()
    error = stderr.read().decode().strip()
    if stdout.channel.recv_exit_status() or error:
        raise RuntimeError(error or output)
    result = __import__("json").loads(output)
    if not result.get("ok"):
        raise RuntimeError(output)
    print("Installed Wi-Fi helper checkpoint and safety-timer probe passed")
finally:
    client.close()
