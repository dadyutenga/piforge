# PiForge architecture and implementation plan

PiForge is a single-user, LAN-first workstation for a Raspberry Pi 3 B+. A Go
process serves plain HTML, CSS, and JavaScript with authenticated JSON/WebSocket
APIs. The browser never talks directly to `nmcli`, systemd, or the filesystem.

## Runtime boundaries

- **Web process:** runs as an unprivileged `dadi` service with journal read
  access through `systemd-journal`. It owns a SQLite database, a bounded metrics
  ring, and terminal sessions for its own Unix user.
- **Private files:** file and project APIs are rooted in a configured workspace.
  Hidden credentials and PiForge's database are excluded from these APIs.
- **Privileged controls:** root-owned Wi-Fi and Bluetooth helpers accept only
  enumerated operations over group-limited Unix sockets. The web process has no
  root privileges. Service mutations remain unavailable.
- **Network:** the installed service binds to the Pi's LAN on HTTPS port 8787
  with a locally generated self-signed certificate and secure cookies. Public
  port forwarding is not part of the install.

## Data flow

```text
Vanilla JS app ── same-origin HTTPS ── Fiber API ── Linux /proc, systemd, NM, BlueZ
          └─ authenticated WS ── PTY owned by dadi
                              └─ SQLite users, sessions and audit
                         └─ restricted Unix socket ── root Wi-Fi helper ── NetworkManager checkpoint
                         └─ restricted Unix socket ── root Bluetooth helper ── BlueZ
```

System metrics are sampled every two seconds and retained in a bounded in-memory
ring. UI polling follows the same cadence. No metric is generated in the browser.
The device status API is the source of truth for offline/loading/error states.

## Implementation sequence

1. HTML/CSS/JS app shell, semantic tokens, theme, command palette,
   authentication screens. No frontend framework or Node runtime on the Pi.
2. Auth, metrics, device details, processes, services, logs, audit; dashboard
   wired to these APIs.
3. PTY terminal, safe file workspace, Wi-Fi and Bluetooth operations with
   explicit connection and permission states.
4. Projects, CodeMirror editor, Git and application runner with explicit
   runtime configs and bounded jobs.
5. Keyboard/mobile review, tests, HTTPS service install, backup and recovery
   documentation.

## Design direction

- Background `#0B0D12`, rail `#101319`, work surface `#151922`, stroke
  `#29303B`, ink `#F3F5F7`, secondary `#98A2B3`, signal blue `#7B93FF`.
- Inter for interface text; JetBrains Mono for readings, code, and terminal.
- A fixed 236 px navigation rail and compact 64 px header frame a flexible
  workspace. The dashboard opens with a live status strip, followed by a
  four-column health row and a wider activity panel. Tools use the full width.
- The status strip is the memorable element: it treats the Pi as one small
  physical machine with a hostname, connection, uptime and a concise health
  signal. Surfaces and charts remain quiet so measurements lead the eye.

The palette follows the requested dark-first direction. Dense repeated cards
would make the Pi look like a generic admin panel, so the dashboard uses one
primary activity surface and smaller metric modules with restrained dividers.

## API and authorization rules

All `/api/*` endpoints require a session except login and bootstrap status.
Mutations require a session-bound CSRF token and same-origin request. WebSocket
upgrades require session validation and an exact origin match. Audit events are
written only after operations finish. Terminal sessions and background jobs are
concurrency-limited.

The current release documents each endpoint and flags any feature that is
unavailable because the Pi lacks a package, permission, or supported manager.
Wi-Fi changes create a 120-second NetworkManager checkpoint before changing
`wlan0`; explicit confirmation destroys it, while a lost browser connection
leaves NetworkManager to restore the prior state automatically.
