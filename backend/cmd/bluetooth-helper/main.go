// A root-owned, narrowly scoped BlueZ bridge for the PiForge web service.
package main

import (
	"context"
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
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

const socketPath = "/run/piforge-bluetooth/control.sock"

var addressPattern = regexp.MustCompile(`^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$`)
var mu sync.Mutex

type request struct {
	Action  string `json:"action"`
	Address string `json:"address,omitempty"`
}

type response struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func run(timeout time.Duration, program string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return "", errors.New("Bluetooth operation timed out")
	}
	if len(output) > 32<<10 {
		return "", errors.New("Bluetooth response exceeded limit")
	}
	if err != nil {
		return "", fmt.Errorf("Bluetooth command failed: %w", err)
	}
	return strings.TrimSpace(string(output)), nil
}

func blue(timeout time.Duration, args ...string) (string, error) {
	return run(timeout, "/usr/bin/bluetoothctl", args...)
}

func powered() (bool, error) {
	out, err := blue(5*time.Second, "show")
	if err != nil || !strings.Contains(out, "Controller ") {
		return false, errors.New("Bluetooth adapter is unavailable")
	}
	return strings.Contains(out, "Powered: yes"), nil
}

func deviceInfo(address string) (string, error) {
	if !addressPattern.MatchString(address) {
		return "", errors.New("invalid Bluetooth address")
	}
	out, err := blue(5*time.Second, "info", address)
	if err != nil || !strings.Contains(strings.ToUpper(out), strings.ToUpper(address)) || !strings.Contains(out, "Paired:") {
		return "", errors.New("Bluetooth device is not known to this Pi; scan first")
	}
	return out, nil
}

func has(info, field string) bool { return strings.Contains(info, field+": yes") }

func change(req request) error {
	switch req.Action {
	case "probe":
		_, err := powered()
		return err
	case "power-on":
		if _, err := run(5*time.Second, "/usr/sbin/rfkill", "unblock", "bluetooth"); err != nil {
			return errors.New("could not unblock Bluetooth radio")
		}
		_, commandErr := blue(10*time.Second, "power", "on")
		on, statusErr := powered()
		if statusErr == nil && on {
			return nil
		}
		if commandErr != nil {
			return errors.New("could not turn Bluetooth on")
		}
		if statusErr != nil || !on {
			return errors.New("Bluetooth radio stayed off; check rfkill or adapter status")
		}
		return nil
	case "power-off":
		_, commandErr := blue(10*time.Second, "power", "off")
		on, statusErr := powered()
		if statusErr == nil && !on {
			return nil
		}
		if commandErr != nil {
			return errors.New("could not turn Bluetooth off")
		}
		if statusErr != nil || on {
			return errors.New("Bluetooth radio did not turn off")
		}
		return nil
	case "scan":
		on, err := powered()
		if err != nil || !on {
			return errors.New("turn Bluetooth on before scanning")
		}
		// The timeout closes this discovery session. BlueZ retains recently seen
		// device objects long enough for the following UI refresh.
		if _, err := blue(12*time.Second, "--timeout", "8", "scan", "on"); err != nil {
			return errors.New("Bluetooth scan failed")
		}
		return nil
	case "pair", "connect", "disconnect", "remove":
		info, err := deviceInfo(req.Address)
		if err != nil {
			return err
		}
		switch req.Action {
		case "pair":
			if has(info, "Paired") {
				return nil
			}
			if _, err := blue(38*time.Second, "--agent", "NoInputNoOutput", "--timeout", "32", "pair", req.Address); err != nil {
				return errors.New("pairing failed; this device may require a PIN or passkey")
			}
			info, err = deviceInfo(req.Address)
			if err != nil || !has(info, "Paired") {
				return errors.New("pairing did not complete; device may require a PIN or passkey")
			}
		case "connect":
			if !has(info, "Paired") {
				return errors.New("pair this device before connecting")
			}
			if has(info, "Connected") {
				return nil
			}
			if _, err := blue(25*time.Second, "--timeout", "20", "connect", req.Address); err != nil {
				return errors.New("Bluetooth connection failed; ensure the device is nearby and ready")
			}
			info, err = deviceInfo(req.Address)
			if err != nil || !has(info, "Connected") {
				return errors.New("device did not connect")
			}
		case "disconnect":
			if !has(info, "Connected") {
				return nil
			}
			if _, err := blue(15*time.Second, "disconnect", req.Address); err != nil {
				return errors.New("could not disconnect device")
			}
			info, err = deviceInfo(req.Address)
			if err != nil || has(info, "Connected") {
				return errors.New("device is still connected")
			}
		case "remove":
			if _, err := blue(10*time.Second, "remove", req.Address); err != nil {
				return errors.New("could not remove device")
			}
			// BlueZ may retain a transient discovery object, but pairing must be gone.
			info, err = deviceInfo(req.Address)
			if err == nil && has(info, "Paired") {
				return errors.New("device is still paired")
			}
		}
		return nil
	default:
		return errors.New("unsupported Bluetooth operation")
	}
}

func serve(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(50 * time.Second))
	var req request
	decoder := json.NewDecoder(io.LimitReader(conn, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&req) != nil {
		_ = json.NewEncoder(conn).Encode(response{Error: "invalid Bluetooth request"})
		return
	}
	mu.Lock()
	err := change(req)
	mu.Unlock()
	if err != nil {
		_ = json.NewEncoder(conn).Encode(response{Error: err.Error()})
		return
	}
	_ = json.NewEncoder(conn).Encode(response{OK: true})
}

func main() {
	if os.Geteuid() != 0 {
		slog.Error("Bluetooth helper must run as root")
		os.Exit(1)
	}
	group, err := user.LookupGroup("dadi")
	if err != nil {
		slog.Error("service group missing", "error", err)
		os.Exit(1)
	}
	var gid int
	if _, err := fmt.Sscan(group.Gid, &gid); err != nil {
		os.Exit(1)
	}
	if err := os.MkdirAll("/run/piforge-bluetooth", 0750); err != nil {
		os.Exit(1)
	}
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		os.Exit(1)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		slog.Error("cannot listen", "error", err)
		os.Exit(1)
	}
	defer listener.Close()
	if err := os.Chown(socketPath, 0, gid); err != nil {
		os.Exit(1)
	}
	if err := os.Chmod(socketPath, 0660); err != nil {
		os.Exit(1)
	}
	defer os.Remove(socketPath)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-stop; _ = listener.Close() }()
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go serve(conn)
	}
}
