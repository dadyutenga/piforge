# PiForge HTTP API

All paths are relative to the same HTTPS origin as the web app. JSON responses
use `{ "error": "..." }` for failures. Except for bootstrap and login, `/api/*`
requires the `piforge_session` cookie. POST, PUT and DELETE also require the
`X-CSRF-Token` returned by login or `/api/session`; requests with an Origin
header must match the server origin.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/bootstrap` | Whether the first admin exists. |
| POST | `/api/login` | `{username,password}`; sets secure session cookie, returns username, CSRF token and expiry. |
| GET | `/api/session` | Current session and CSRF token. |
| POST | `/api/logout` | Revoke current session. |
| POST | `/api/account/password` | `{current,next}`; changes password and revokes sessions. |
| GET | `/api/system` | Live device details, CPU, memory, disk, temperature and bounded history. `capturedAt` is the timestamp of the latest metric sample. |
| GET | `/api/activity` | Recent audit events. |
| GET | `/api/capabilities` | Availability of privileged controls. |
| GET | `/api/processes` | Up to 100 processes ordered by CPU use. |
| POST | `/api/processes/:pid/terminate` | Send SIGTERM; Linux user permissions apply. |
| GET | `/api/services` | systemd service list. |
| POST | `/api/services/:unit/:action` | Start, stop, restart, enable or disable; requires a separately installed restricted helper. |
| GET | `/api/logs?unit=name.service` | Up to 200 journal lines, optionally one unit. |
| GET | `/api/storage` | `lsblk` JSON. |
| GET | `/api/network` | IP addresses and routes. |
| GET | `/api/wifi` | NetworkManager status, Wi-Fi radio state, visible networks, saved profile identifiers, fallback-route status and pending change; no passwords. |
| POST | `/api/wifi/scan` | Force a fresh scan on `wlan0`; returns only networks detected by the Pi. |
| GET | `/api/wifi/pending` | Status of an unconfirmed Wi-Fi change. |
| POST | `/api/wifi/connect` | `{ssid,password,hidden?}`; create and activate open or WPA-PSK profile under a two-minute rollback checkpoint. `hidden:true` supports connection by name. |
| POST | `/api/wifi/activate` | `{uuid}`; activate an existing saved Wi-Fi profile under a rollback checkpoint. |
| POST | `/api/wifi/disconnect` | Disconnect `wlan0` under a rollback checkpoint. |
| POST | `/api/wifi/radio` | `{enabled:true}` turns Wi-Fi on. `{enabled:false}` turns it off under a NetworkManager checkpoint and an independent two-minute systemd recovery timer. |
| POST | `/api/wifi/forget` | `{uuid}`; delete an inactive saved Wi-Fi profile. |
| POST | `/api/wifi/confirm` | `{id}`; keep the pending connection and cancel automatic rollback. |
| POST | `/api/wifi/revert` | `{id}`; immediately restore the previous connection. |
| GET | `/api/bluetooth` | BlueZ adapter, known, paired and connected devices; helper availability. |
| POST | `/api/bluetooth/power` | `{enabled:boolean}`; change adapter power through the restricted helper. |
| POST | `/api/bluetooth/scan` | Scan for nearby Bluetooth devices for eight seconds. |
| POST | `/api/bluetooth/pair` | `{address}`; pair a known device using a NoInputNoOutput agent. PIN/passkey pairing is unsupported. |
| POST | `/api/bluetooth/connect` | `{address}`; connect a paired device. |
| POST | `/api/bluetooth/disconnect` | `{address}`; disconnect a known device. |
| POST | `/api/bluetooth/remove` | `{address}`; remove a known device and its pairing. |
| GET | `/api/files?path=folder` | List up to 500 workspace entries. |
| GET | `/api/files/content?path=file` | Read text, up to 2 MiB. |
| PUT | `/api/files/content` | `{path,content}`; create or save text. |
| POST | `/api/files/folder` | `{path}`; create directory. |
| POST | `/api/files/rename` | `{from,to}`. |
| POST | `/api/files/copy` | `{from,to}`; regular files up to 100 MiB. |
| DELETE | `/api/files?path=item` | Remove a workspace item recursively. |
| POST | `/api/files/upload` | Multipart `file` and `path`; 32 MiB request limit. |
| GET | `/api/files/download?path=file` | Download a regular workspace file. |
| WS | `/ws/terminal` | Authenticated PTY; text JSON `{type:"input",data}` or `{type:"resize",cols,rows}`, binary PTY output. |

The Wi-Fi helper is a separate root-owned process with a group-limited Unix
socket. It accepts only the operations above and uses NetworkManager's D-Bus
checkpoint for connection rollback. A radio-off change additionally uses a
systemd timer because a NetworkManager checkpoint does not cover the global
Wi-Fi radio setting. The Bluetooth helper has its own group-limited Unix socket
and accepts only fixed actions with validated device addresses. Service changes
still return 403 until a separate service helper is installed.
