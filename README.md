# PiForge

A lightweight Raspberry Pi workstation served by one Go process. The browser
interface is plain HTML, CSS and JavaScript. There is no React bundle, frontend
framework runtime, or Node.js service on the Pi.

This build is installed on the Raspberry Pi 3 B+ at
**https://10.0.0.56:8787**. Its first certificate is self-signed, so a browser
will ask you to review and accept it. The service runs as the non-root `dadi`
account and starts automatically with systemd. The initial PiForge username is
`dadi`; the PiForge password is separate from the Linux/SSH password. Change it
in Settings after your first login.

## What works now

| Area | Status |
| --- | --- |
| Login, sessions, CSRF, password change, audit | Working |
| Live CPU, memory, disk, temperature, activity history | Working on the Pi; browser refreshes every two seconds |
| Process list and termination | Working within Linux user permissions |
| Services, journal, storage, network | Live read-only views |
| Browser terminal | Real PTY as `dadi`, three concurrent sessions maximum |
| Workspace files | List, upload, download, create, copy, rename, delete, text preview |
| Code editor | CodeMirror loaded only when opened; real file save |
| Wi-Fi | Live nearby-network list and manual rescan; radio on/off switch; connect to open/WPA-PSK networks (including hidden SSIDs by name), activate saved profiles, disconnect and forget inactive profiles; two-minute recovery safeguard |
| Bluetooth | Power on/off, scan, pair, connect, disconnect and remove devices through a restricted helper; PIN/passkey pairing is not supported |
| Theme, command search, mobile layout | Working |

The original product brief also describes project management, Git, app
deployments, databases, backups, scheduled jobs, Bluetooth PIN/passkey pairing, static IP
editing, enterprise Wi-Fi and richer file operations. Those are **not implemented**. There are no
decorative controls that claim those operations succeeded. The service control
API exists but returns 403 until a restricted service helper is designed and
installed. Wi-Fi and Bluetooth use separate root-owned helpers over local Unix
sockets; their allowed operations are fixed in code and the Go web process stays non-root.

At installation time, the Pi had **no connected Ethernet route**. Wi-Fi was its
only active route; PiForge checks this live and warns when it remains true. A
new connection or disconnect can close your browser session. PiForge
creates a NetworkManager checkpoint before changing `wlan0`; unless you click
**Keep connection** within two minutes, NetworkManager restores the previous
state automatically. Turning the Wi-Fi radio off also schedules a separate
systemd timer to turn it back on after two minutes. The timer is scheduled
before the radio is disabled and the helper recovers an unconfirmed radio-off
change on startup. To keep Wi-Fi off, confirm the change through Ethernet or
another active route. If a new network changes the Pi's IP address, open
PiForge at the new address to confirm; otherwise wait for rollback at the old
address. **Scan again** forces a fresh NetworkManager scan; the page only
shows networks that the Pi's adapter actually detects. On the latest scan,
this Pi saw only `DADI`. Use **Connect by name** for a hidden SSID. The
checkpoint, safety-timer scheduling, helper permissions and safe no-op
activation have been tested on the Pi. A live radio-off or switch to a
different network has not been exercised because it would interrupt the only
access route.

## Build and deploy

Build on a development computer with Go 1.27.1 or later:

```powershell
$env:GOOS='linux'
$env:GOARCH='arm64'
$env:CGO_ENABLED='0'
go build -o .\dist\piforge ./backend/cmd/server
go build -o .\dist\piforge-wifi-helper ./backend/cmd/wifi-helper
go build -o .\dist\piforge-bluetooth-helper ./backend/cmd/bluetooth-helper
```

The checked-in `web/` directory is already built. No npm install is needed to
serve it. `scripts/install-pi.py` uses Paramiko and copies all three binaries, static
files, systemd units and a self-signed LAN certificate to the configured Pi.
Set `PIFORGE_SSH_PASSWORD` in your shell before running it. The script verifies
the Pi's SSH host key against `~/.ssh/known_hosts` and uses the SSH password
only for the connection and sudo, never in a file.

```powershell
python .\scripts\install-pi.py
```

On the Pi, service status and logs:

```sh
sudo systemctl status piforge
journalctl -u piforge -n 100 --no-pager
```

For a fresh installation, run `piforge init-admin <username>` in a terminal
before starting the service. It prompts for a password of at least 12
characters. The current installation already has an administrator.

For local development, `PIFORGE_INSECURE_HTTP=1` binds the Go process to
`127.0.0.1:8787` by default. Access that mode only through an SSH tunnel;
normal LAN serving requires `PIFORGE_TLS_CERT` and `PIFORGE_TLS_KEY`.

## Security and data

The SQLite database and TLS key live in
`/home/dadi/.local/share/piforge/`; the file workspace is
`/home/dadi/PiForge/`. File APIs use Go's `os.Root` to keep requests in this
workspace and reject traversal or symlink escapes. The terminal deliberately
has the same access as the `dadi` Unix user, so only trusted people should
receive PiForge credentials. Keep port 8787 on the private LAN or VPN; do not
forward it to the public internet.

The certificate is encrypted transport but is **not independently trusted** by
your browser. Replace it with a certificate trusted by your devices if you
want to remove the browser warning. If the Pi's LAN IP changes, regenerate the
certificate with a subject alternative name for the new IP and restart the
service.

For protected Wi-Fi, the helper passes the password to NetworkManager through
a temporary root-only file and removes it after activation. PiForge never
returns saved Wi-Fi passwords in its API.

For a cold backup, stop `piforge`, copy the data directory and workspace to a
safe location, then start the service again. Restore those directories with
owner `dadi:dadi` and private permissions before starting the service. Keep the
SQLite database, its `-wal`/`-shm` files, and the TLS key together. No
automated backup UI is implemented yet.

## Tests and docs

- `docs/architecture.md` records the runtime boundaries and design plan.
- `docs/api.md` lists the HTTP and WebSocket endpoints.
- `scripts/smoke-ui.mjs` checks login, live dashboard, PTY output, file editing,
  and mobile rendering in a browser. It uses Playwright Core on the development
  PC and accepts `PIFORGE_TEST_URL` and `PIFORGE_TEST_PASSWORD` environment
  variables.
- `scripts/repro-live-workspace.mjs` checks two-second dashboard updates,
  rapid navigation while terminal and editor assets load, real terminal output,
  file saving, and mobile workspace layout.
- `scripts/test-dashboard-live.mjs` checks that the dashboard displays successive
  real samples, shows their capture time, and reports offline/reconnected state.
- `scripts/test-bluetooth-ui.mjs` checks real adapter power off/on, device scan,
  invalid and unknown device rejection, and the mobile Bluetooth controls.
- `backend/cmd/bluetooth-helper/main_test.go` checks strict device-address
  validation. Power and scan were exercised on the Pi; pairing with a real
  device still needs a compatible device placed in pairing mode.
- `backend/internal/workspace/workspace_test.go` checks file operations and
  escape prevention. It was cross-compiled and run on the Pi.
- `backend/cmd/wifi-helper/main_test.go` checks network input validation.
  `scripts/probe-wifi-helper.py` checks checkpoint and safety-timer scheduling
  without switching networks, and `scripts/test-wifi-forget.py` exercises a safe,
  inactive-profile deletion through the authenticated API.

The Pi itself needs neither Node.js nor a Go toolchain to run the installed app.
