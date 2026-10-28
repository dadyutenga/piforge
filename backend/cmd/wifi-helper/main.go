// PiForge's root-owned Wi-Fi helper. Its Unix socket accepts only the operations
// defined below; it never accepts a command line or executable from the web app.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	runDir          = "/run/piforge-helper"
	socketPath      = runDir + "/control.sock"
	stateDir        = "/var/lib/piforge-helper"
	statePath       = stateDir + "/transaction.json"
	lockPath        = stateDir + "/lock"
	helperBinary    = "/usr/local/libexec/piforge-wifi-helper"
	rollbackSeconds = 120
)

var (
	uuidPattern       = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	checkpointPattern = regexp.MustCompile(`^/org/freedesktop/NetworkManager/Checkpoint/[0-9]+$`)
	devicePattern     = regexp.MustCompile(`^/org/freedesktop/NetworkManager/Devices/[0-9]+$`)
	checkpointOutput  = regexp.MustCompile(`/org/freedesktop/NetworkManager/Checkpoint/[0-9]+`)
	mu                sync.Mutex
)

type request struct {
	Action   string `json:"action"`
	SSID     string `json:"ssid,omitempty"`
	Password string `json:"password,omitempty"`
	Hidden   bool   `json:"hidden,omitempty"`
	UUID     string `json:"uuid,omitempty"`
	ID       string `json:"id,omitempty"`
}

type transaction struct {
	ID           string `json:"id"`
	Checkpoint   string `json:"checkpoint"`
	Action       string `json:"action"`
	Target       string `json:"target"`
	Profile      string `json:"profile,omitempty"`
	PreviousUUID string `json:"previousUuid,omitempty"`
	ExpiresAt    int64  `json:"expiresAt"`
}

type response struct {
	OK      bool         `json:"ok"`
	Error   string       `json:"error,omitempty"`
	Pending *transaction `json:"pending,omitempty"`
}

func command(timeout time.Duration, binary string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return "", errors.New("operation timed out")
	}
	if len(out) > 16<<10 {
		return "", errors.New("command output exceeded limit")
	}
	if err != nil {
		return "", fmt.Errorf("command failed: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func nmcli(timeout time.Duration, args ...string) (string, error) {
	return command(timeout, "/usr/bin/nmcli", args...)
}

func busctl(method, signature string, args ...string) (string, error) {
	params := []string{"call", "org.freedesktop.NetworkManager", "/org/freedesktop/NetworkManager", "org.freedesktop.NetworkManager", method, signature}
	return command(8*time.Second, "/usr/bin/busctl", append(params, args...)...)
}

func lockState() (func(), error) {
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		_ = file.Close()
		return nil, err
	}
	return func() { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN); _ = file.Close() }, nil
}

func readState() (*transaction, error) {
	data, err := os.ReadFile(statePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var tx transaction
	if err := json.Unmarshal(data, &tx); err != nil {
		return nil, err
	}
	if !checkpointPattern.MatchString(tx.Checkpoint) {
		return nil, errors.New("invalid stored checkpoint")
	}
	return &tx, nil
}

func current() (*transaction, error) {
	tx, err := readState()
	if err != nil || tx == nil {
		return tx, err
	}
	if time.Now().Unix() > tx.ExpiresAt+5 {
		if tx.Action == "radio-off" {
			if err := restoreRadio(tx); err != nil {
				return tx, nil
			}
			return nil, nil
		}
		_ = os.Remove(statePath)
		return nil, nil
	}
	return tx, nil
}

func save(tx *transaction) error {
	data, err := json.Marshal(tx)
	if err != nil {
		return err
	}
	tmp := statePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, statePath)
}

func randomID() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func begin(action, target string) (*transaction, error) {
	previous, err := current()
	if err != nil {
		return nil, err
	}
	if previous != nil {
		return nil, errors.New("another Wi-Fi change is awaiting confirmation")
	}
	path, err := nmcli(5*time.Second, "-g", "GENERAL.DBUS-PATH", "device", "show", "wlan0")
	if err != nil || !devicePattern.MatchString(path) {
		return nil, errors.New("NetworkManager does not manage wlan0")
	}
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	// Flag 2 deletes newly created profiles if the checkpoint is rolled back.
	out, err := busctl("CheckpointCreate", "aouu", "1", path, fmt.Sprint(rollbackSeconds), "2")
	if err != nil {
		return nil, errors.New("could not create a NetworkManager rollback checkpoint")
	}
	checkpoint := checkpointOutput.FindString(out)
	if !checkpointPattern.MatchString(checkpoint) {
		return nil, errors.New("NetworkManager returned an invalid checkpoint")
	}
	tx := &transaction{ID: id, Checkpoint: checkpoint, Action: action, Target: target, ExpiresAt: time.Now().Add(rollbackSeconds * time.Second).Unix()}
	if err := save(tx); err != nil {
		_, _ = busctl("CheckpointDestroy", "o", checkpoint)
		return nil, err
	}
	return tx, nil
}

func rollback(tx *transaction) error {
	_, err := busctl("CheckpointRollback", "o", tx.Checkpoint)
	if err == nil {
		_ = os.Remove(statePath)
	}
	return err
}

func validSSID(ssid string) bool {
	return len(ssid) >= 1 && len(ssid) <= 32 && !strings.HasPrefix(ssid, "-") && !strings.ContainsAny(ssid, "\x00\r\n")
}

func validPassword(password string) bool {
	return password == "" || (len(password) >= 8 && len(password) <= 63 && !strings.ContainsAny(password, "\x00\r\n"))
}

func wifiProfile(uuid string) error {
	if !uuidPattern.MatchString(uuid) {
		return errors.New("invalid profile identifier")
	}
	kind, err := nmcli(5*time.Second, "-g", "connection.type", "connection", "show", "uuid", uuid)
	if err != nil || kind != "802-11-wireless" {
		return errors.New("that Wi-Fi profile does not exist")
	}
	return nil
}

func activeUUID() string {
	uuid, err := nmcli(5*time.Second, "-g", "GENERAL.CON-UUID", "device", "show", "wlan0")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(uuid)
}

func radioEnabled() (bool, error) {
	value, err := nmcli(5*time.Second, "radio", "wifi")
	if err != nil {
		return false, err
	}
	return value == "enabled", nil
}

func timerName(id string) string { return "piforge-wifi-radio-" + id }

func scheduleRadioTimer(id string) error {
	unit := timerName(id)
	_, err := command(8*time.Second, "/usr/bin/systemd-run", "--unit="+unit, "--on-active=120s", "--timer-property=AccuracySec=1s", "--property=Type=exec", helperBinary, "restore-radio", id)
	return err
}

func cancelRadioTimer(id string) {
	_, _ = command(5*time.Second, "/usr/bin/systemctl", "stop", timerName(id)+".timer")
}

func restoreRadio(tx *transaction) error {
	if _, err := nmcli(10*time.Second, "radio", "wifi", "on"); err != nil {
		return errors.New("could not restore Wi-Fi radio")
	}
	// The NetworkManager checkpoint may already have timed out. A failed explicit
	// rollback is safe here because the radio is on and NM owns that checkpoint.
	_, _ = busctl("CheckpointRollback", "o", tx.Checkpoint)
	if uuidPattern.MatchString(tx.PreviousUUID) {
		_, _ = nmcli(50*time.Second, "-w", "45", "connection", "up", "uuid", tx.PreviousUUID, "ifname", "wlan0")
	}
	cancelRadioTimer(tx.ID)
	_ = os.Remove(statePath)
	return nil
}

func change(req request) (response, error) {
	switch req.Action {
	case "status":
		tx, err := current()
		return response{OK: true, Pending: tx}, err
	case "probe":
		// Diagnostic: exercise the checkpoint path without changing the network.
		tx, err := begin("probe", "wlan0")
		if err != nil {
			return response{}, err
		}
		if _, err := busctl("CheckpointDestroy", "o", tx.Checkpoint); err != nil {
			return response{}, errors.New("could not close the test checkpoint")
		}
		_ = os.Remove(statePath)
		probeID, err := randomID()
		if err != nil {
			return response{}, err
		}
		probeUnit := "piforge-wifi-probe-" + probeID
		if _, err := command(8*time.Second, "/usr/bin/systemd-run", "--unit="+probeUnit, "--on-active=30s", "--timer-property=AccuracySec=1s", "/usr/bin/true"); err != nil {
			return response{}, errors.New("could not schedule a safety timer")
		}
		_, _ = command(5*time.Second, "/usr/bin/systemctl", "stop", probeUnit+".timer")
		return response{OK: true}, nil
	case "radio-on":
		tx, err := current()
		if err != nil {
			return response{}, err
		}
		if tx != nil && tx.Action == "radio-off" {
			if err := restoreRadio(tx); err != nil {
				return response{}, err
			}
			return response{OK: true}, nil
		}
		if tx != nil {
			return response{}, errors.New("confirm or revert the pending Wi-Fi change first")
		}
		enabled, err := radioEnabled()
		if err != nil {
			return response{}, errors.New("Wi-Fi radio status is unavailable")
		}
		if enabled {
			return response{OK: true}, nil
		}
		if _, err := nmcli(10*time.Second, "radio", "wifi", "on"); err != nil {
			return response{}, errors.New("could not turn Wi-Fi on")
		}
		return response{OK: true}, nil
	case "radio-off":
		enabled, err := radioEnabled()
		if err != nil {
			return response{}, errors.New("Wi-Fi radio status is unavailable")
		}
		if !enabled {
			return response{OK: true}, nil
		}
		previous := activeUUID()
		tx, err := begin("radio-off", "wlan0")
		if err != nil {
			return response{}, err
		}
		tx.PreviousUUID = previous
		if err := save(tx); err != nil {
			_ = rollback(tx)
			return response{}, err
		}
		if err := scheduleRadioTimer(tx.ID); err != nil {
			_ = rollback(tx)
			return response{}, errors.New("could not schedule automatic Wi-Fi recovery; radio stayed on")
		}
		if _, err := nmcli(12*time.Second, "radio", "wifi", "off"); err != nil {
			cancelRadioTimer(tx.ID)
			_ = restoreRadio(tx)
			return response{}, errors.New("could not turn Wi-Fi off; previous connection was restored")
		}
		return response{OK: true, Pending: tx}, nil
	case "connect":
		if !validSSID(req.SSID) || !validPassword(req.Password) {
			return response{}, errors.New("invalid network name or WPA password")
		}
		tx, err := begin("connect", req.SSID)
		if err != nil {
			return response{}, err
		}
		name := "PiForge-" + tx.ID
		args := []string{"connection", "add", "type", "wifi", "ifname", "wlan0", "con-name", name, "ssid", req.SSID, "connection.autoconnect", "no"}
		if req.Hidden {
			args = append(args, "wifi.hidden", "yes")
		}
		if req.Password != "" {
			args = append(args, "wifi-sec.key-mgmt", "wpa-psk")
		}
		if _, err := nmcli(10*time.Second, args...); err != nil {
			_ = rollback(tx)
			return response{}, errors.New("could not create the Wi-Fi profile; previous connection was restored")
		}
		tx.Profile = name
		if err := save(tx); err != nil {
			_ = rollback(tx)
			return response{}, err
		}
		up := []string{"-w", "55", "connection", "up", "id", name, "ifname", "wlan0"}
		if req.Password != "" {
			secret := filepath.Join(runDir, "secret-"+tx.ID)
			file, err := os.OpenFile(secret, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				_ = rollback(tx)
				return response{}, err
			}
			_, writeErr := io.WriteString(file, "802-11-wireless-security.psk:"+req.Password+"\n")
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				_ = os.Remove(secret)
				_ = rollback(tx)
				return response{}, errors.New("could not prepare a protected Wi-Fi credential")
			}
			defer os.Remove(secret)
			up = append(up, "passwd-file", secret)
		}
		if _, err := nmcli(60*time.Second, up...); err != nil {
			_ = rollback(tx)
			return response{}, errors.New("Wi-Fi connection failed; previous connection was restored or will be restored automatically")
		}
		return response{OK: true, Pending: tx}, nil
	case "activate":
		if err := wifiProfile(req.UUID); err != nil {
			return response{}, err
		}
		if activeUUID() == req.UUID {
			return response{OK: true}, nil
		}
		tx, err := begin("activate", req.UUID)
		if err != nil {
			return response{}, err
		}
		if _, err := nmcli(60*time.Second, "-w", "55", "connection", "up", "uuid", req.UUID, "ifname", "wlan0"); err != nil {
			_ = rollback(tx)
			return response{}, errors.New("saved Wi-Fi profile could not connect; previous connection was restored or will be restored automatically")
		}
		return response{OK: true, Pending: tx}, nil
	case "disconnect":
		if activeUUID() == "" {
			return response{}, errors.New("Wi-Fi is already disconnected")
		}
		tx, err := begin("disconnect", "wlan0")
		if err != nil {
			return response{}, err
		}
		if _, err := nmcli(15*time.Second, "-w", "10", "device", "disconnect", "wlan0"); err != nil {
			_ = rollback(tx)
			return response{}, errors.New("could not disconnect Wi-Fi; previous connection was restored")
		}
		return response{OK: true, Pending: tx}, nil
	case "forget":
		if err := wifiProfile(req.UUID); err != nil {
			return response{}, err
		}
		if activeUUID() == req.UUID {
			return response{}, errors.New("disconnect or switch away before forgetting the active network")
		}
		if tx, err := current(); err != nil {
			return response{}, err
		} else if tx != nil {
			return response{}, errors.New("confirm or revert the pending Wi-Fi change first")
		}
		if _, err := nmcli(10*time.Second, "connection", "delete", "uuid", req.UUID); err != nil {
			return response{}, errors.New("could not forget this Wi-Fi profile")
		}
		return response{OK: true}, nil
	case "confirm", "revert":
		tx, err := current()
		if err != nil {
			return response{}, err
		}
		if tx == nil || req.ID == "" || tx.ID != req.ID {
			return response{}, errors.New("Wi-Fi confirmation expired or does not match")
		}
		if req.Action == "revert" {
			if tx.Action == "radio-off" {
				if err := restoreRadio(tx); err != nil {
					return response{}, err
				}
				return response{OK: true}, nil
			}
			if err := rollback(tx); err != nil {
				return response{}, errors.New("rollback is still pending in NetworkManager")
			}
			return response{OK: true}, nil
		}
		if tx.Profile != "" {
			if _, err := nmcli(5*time.Second, "connection", "modify", "id", tx.Profile, "connection.autoconnect", "yes"); err != nil {
				return response{}, errors.New("could not save auto-connect for this profile")
			}
		}
		if _, err := busctl("CheckpointDestroy", "o", tx.Checkpoint); err != nil {
			return response{}, errors.New("could not confirm this Wi-Fi change")
		}
		if tx.Action == "radio-off" {
			cancelRadioTimer(tx.ID)
		}
		_ = os.Remove(statePath)
		return response{OK: true}, nil
	default:
		return response{}, errors.New("unsupported Wi-Fi operation")
	}
}

func serveConnection(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(75 * time.Second))
	var req request
	decoder := json.NewDecoder(io.LimitReader(conn, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		_ = json.NewEncoder(conn).Encode(response{Error: "invalid helper request"})
		return
	}
	mu.Lock()
	unlock, lockErr := lockState()
	if lockErr != nil {
		mu.Unlock()
		_ = json.NewEncoder(conn).Encode(response{Error: "Wi-Fi helper state is unavailable"})
		return
	}
	result, err := change(req)
	unlock()
	mu.Unlock()
	if err != nil {
		result = response{Error: err.Error()}
	}
	_ = json.NewEncoder(conn).Encode(result)
}

func main() {
	if os.Geteuid() != 0 {
		slog.Error("Wi-Fi helper must run as root")
		os.Exit(1)
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		slog.Error("cannot create state directory", "error", err)
		os.Exit(1)
	}
	if len(os.Args) > 1 {
		if len(os.Args) != 3 || os.Args[1] != "restore-radio" || len(os.Args[2]) != 24 {
			os.Exit(2)
		}
		if _, err := hex.DecodeString(os.Args[2]); err != nil {
			os.Exit(2)
		}
		unlock, err := lockState()
		if err != nil {
			slog.Error("cannot lock state", "error", err)
			os.Exit(1)
		}
		defer unlock()
		tx, err := readState()
		if err != nil {
			slog.Error("cannot read state", "error", err)
			os.Exit(1)
		}
		if tx != nil && tx.Action == "radio-off" && tx.ID == os.Args[2] {
			if err := restoreRadio(tx); err != nil {
				slog.Error("cannot restore radio", "error", err)
				os.Exit(1)
			}
		}
		return
	}
	unlock, err := lockState()
	if err != nil {
		slog.Error("cannot lock state", "error", err)
		os.Exit(1)
	}
	if pending, err := readState(); err == nil && pending != nil && pending.Action == "radio-off" {
		if err := restoreRadio(pending); err != nil {
			slog.Error("cannot recover Wi-Fi on startup", "error", err)
		}
	}
	unlock()
	group, err := user.LookupGroup("dadi")
	if err != nil {
		slog.Error("cannot find service group", "error", err)
		os.Exit(1)
	}
	var gid int
	if _, err := fmt.Sscan(group.Gid, &gid); err != nil {
		slog.Error("invalid service group", "error", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(runDir, 0750); err != nil {
		slog.Error("cannot create runtime directory", "error", err)
		os.Exit(1)
	}
	if leftovers, err := filepath.Glob(filepath.Join(runDir, "secret-*")); err == nil {
		for _, path := range leftovers {
			_ = os.Remove(path)
		}
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Error("cannot remove stale socket", "error", err)
		os.Exit(1)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		slog.Error("cannot listen", "error", err)
		os.Exit(1)
	}
	defer listener.Close()
	if err := os.Chown(socketPath, 0, gid); err != nil {
		slog.Error("cannot set socket group", "error", err)
		os.Exit(1)
	}
	if err := os.Chmod(socketPath, 0660); err != nil {
		slog.Error("cannot secure socket", "error", err)
		os.Exit(1)
	}
	defer os.Remove(socketPath)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-stop; _ = listener.Close() }()
	for {
		conn, err := listener.Accept()
		if err != nil {
			break
		}
		go serveConnection(conn)
	}
}
