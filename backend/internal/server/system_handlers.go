package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
)

type Process struct {
	PID    int     `json:"pid"`
	User   string  `json:"user"`
	CPU    float64 `json:"cpu"`
	Memory float64 `json:"memory"`
	State  string  `json:"state"`
	Name   string  `json:"name"`
}

type Service struct {
	Name        string `json:"name"`
	Load        string `json:"load"`
	Active      string `json:"active"`
	State       string `json:"state"`
	Description string `json:"description"`
}

func run(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	if out.Len() > 1<<20 {
		return "", errors.New("command output exceeded limit")
	}
	if ctx.Err() != nil {
		return "", errors.New("operation timed out")
	}
	return out.String(), err
}

func processes() ([]Process, error) {
	text, err := run(5*time.Second, "ps", "-eo", "pid=,user=,%cpu=,%mem=,stat=,comm=", "--sort=-%cpu")
	if err != nil {
		return nil, err
	}
	out := make([]Process, 0, 100)
	for _, line := range strings.Split(text, "\n") {
		v := strings.Fields(line)
		if len(v) < 6 {
			continue
		}
		pid, _ := strconv.Atoi(v[0])
		cpu, _ := strconv.ParseFloat(v[2], 64)
		mem, _ := strconv.ParseFloat(v[3], 64)
		out = append(out, Process{PID: pid, User: v[1], CPU: cpu, Memory: mem, State: v[4], Name: v[5]})
		if len(out) == 100 {
			break
		}
	}
	return out, nil
}

func services() ([]Service, error) {
	text, err := run(8*time.Second, "systemctl", "list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend")
	if err != nil {
		return nil, err
	}
	out := make([]Service, 0, 80)
	for _, line := range strings.Split(text, "\n") {
		v := strings.Fields(line)
		if len(v) < 5 {
			continue
		}
		if v[0] == "●" {
			v = v[1:]
			if len(v) < 5 {
				continue
			}
		}
		out = append(out, Service{Name: v[0], Load: v[1], Active: v[2], State: v[3], Description: strings.Join(v[4:], " ")})
	}
	return out, nil
}

func allowedUnit(name string) bool {
	if len(name) < 2 || len(name) > 100 || !strings.HasSuffix(name, ".service") {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' || r == '@') {
			return false
		}
	}
	return true
}

func (s *Server) registerSystem() {
	s.App.Get("/api/processes", func(c *fiber.Ctx) error {
		items, err := processes()
		if err != nil {
			return err
		}
		return c.JSON(items)
	})
	s.App.Post("/api/processes/:pid/terminate", func(c *fiber.Ctx) error {
		pid, err := strconv.Atoi(c.Params("pid"))
		if err != nil || pid < 2 || pid == os.Getpid() {
			return fiber.NewError(400, "Invalid process")
		}
		proc, err := os.FindProcess(pid)
		if err == nil {
			err = proc.Signal(syscall.SIGTERM)
		}
		s.audit(c, "process.terminate", strconv.Itoa(pid), err)
		if err != nil {
			return c.Status(403).JSON(fiber.Map{"error": "Cannot terminate that process"})
		}
		return c.JSON(fiber.Map{"terminated": true})
	})
	s.App.Get("/api/services", func(c *fiber.Ctx) error {
		items, err := services()
		if err != nil {
			return err
		}
		return c.JSON(items)
	})
	s.App.Post("/api/services/:unit/:action", func(c *fiber.Ctx) error {
		unit, action := c.Params("unit"), c.Params("action")
		if !allowedUnit(unit) || !(action == "start" || action == "stop" || action == "restart" || action == "enable" || action == "disable") {
			return fiber.NewError(400, "Unsupported service action")
		}
		helper := os.Getenv("PIFORGE_HELPER")
		if helper == "" {
			return c.Status(403).JSON(fiber.Map{"error": "Service control is not configured on this device"})
		}
		output, err := run(20*time.Second, "sudo", "-n", helper, "service", action, unit)
		s.audit(c, "service."+action, unit, err)
		if err != nil {
			return c.Status(403).JSON(fiber.Map{"error": strings.TrimSpace(output)})
		}
		return c.JSON(fiber.Map{"unit": unit, "action": action, "result": "complete"})
	})
	s.App.Get("/api/logs", func(c *fiber.Ctx) error {
		unit := c.Query("unit")
		args := []string{"-n", "200", "-o", "short-iso", "--no-pager"}
		if unit != "" {
			if !allowedUnit(unit) {
				return fiber.NewError(400, "Invalid service name")
			}
			args = append(args, "-u", unit)
		}
		text, err := run(8*time.Second, "journalctl", args...)
		if err != nil {
			return c.Status(403).JSON(fiber.Map{"error": "System logs are not available to this account"})
		}
		return c.JSON(fiber.Map{"lines": strings.Split(strings.TrimSpace(text), "\n")})
	})
	s.App.Get("/api/storage", func(c *fiber.Ctx) error {
		text, err := run(5*time.Second, "lsblk", "-J", "-b", "-o", "NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE,MODEL")
		if err != nil {
			return err
		}
		var raw json.RawMessage
		if err := json.Unmarshal([]byte(text), &raw); err != nil {
			return err
		}
		return c.Type("json").Send(raw)
	})
	s.App.Get("/api/network", func(c *fiber.Ctx) error {
		addr, err := run(5*time.Second, "ip", "-j", "address")
		if err != nil {
			return err
		}
		routes, err := run(5*time.Second, "ip", "-j", "route")
		if err != nil {
			return err
		}
		var a, r json.RawMessage
		if err := json.Unmarshal([]byte(addr), &a); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(routes), &r); err != nil {
			return err
		}
		return c.JSON(fiber.Map{"interfaces": a, "routes": r})
	})
	s.App.Get("/api/wifi", func(c *fiber.Ctx) error {
		radioText, radioErr := run(5*time.Second, "nmcli", "radio", "wifi")
		if radioErr != nil {
			return c.Status(501).JSON(fiber.Map{"error": "NetworkManager is unavailable"})
		}
		radioEnabled := strings.TrimSpace(radioText) == "enabled"
		status, err := run(8*time.Second, "nmcli", "-t", "-f", "GENERAL.STATE,GENERAL.CONNECTION,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS", "device", "show", "wlan0")
		if err != nil && radioEnabled {
			return c.Status(501).JSON(fiber.Map{"error": "NetworkManager is unavailable"})
		}
		networks := ""
		var scanErr error
		if radioEnabled {
			networks, scanErr = run(12*time.Second, "nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "ifname", "wlan0")
		}
		profiles, _ := run(5*time.Second, "nmcli", "-t", "-f", "UUID,NAME,TYPE,AUTOCONNECT,ACTIVE,DEVICE", "connection", "show")
		activeUUID, _ := run(5*time.Second, "nmcli", "-g", "GENERAL.CON-UUID", "device", "show", "wlan0")
		routes, _ := run(5*time.Second, "ip", "-j", "route", "show", "default")
		var defaultRoutes []struct {
			Dev string `json:"dev"`
		}
		_ = json.Unmarshal([]byte(routes), &defaultRoutes)
		fallbackAvailable := false
		for _, route := range defaultRoutes {
			if route.Dev != "" && route.Dev != "wlan0" {
				fallbackAvailable = true
			}
		}
		controlAvailable := wifiControlAvailable()
		var pending json.RawMessage
		if controlAvailable {
			result, helperErr := callWifiHelper(wifiRequest{Action: "status"})
			if helperErr != nil {
				controlAvailable = false
			} else {
				pending = result.Pending
			}
		}
		if scanErr != nil {
			networks = ""
		}
		return c.JSON(fiber.Map{"status": strings.Split(strings.TrimSpace(status), "\n"), "networks": strings.Split(strings.TrimSpace(networks), "\n"), "profiles": strings.Split(strings.TrimSpace(profiles), "\n"), "activeUUID": strings.TrimSpace(activeUUID), "fallbackAvailable": fallbackAvailable, "radioEnabled": radioEnabled, "pending": pending, "controlAvailable": controlAvailable})
	})
	s.App.Get("/api/bluetooth", func(c *fiber.Ctx) error {
		adapter, err := run(6*time.Second, "bluetoothctl", "show")
		if err != nil {
			return c.Status(501).JSON(fiber.Map{"error": "BlueZ is unavailable"})
		}
		devices, _ := run(6*time.Second, "bluetoothctl", "devices")
		paired, _ := run(6*time.Second, "bluetoothctl", "devices", "Paired")
		connected, _ := run(6*time.Second, "bluetoothctl", "devices", "Connected")
		return c.JSON(fiber.Map{"adapter": adapter, "devices": strings.Split(strings.TrimSpace(devices), "\n"), "paired": strings.Split(strings.TrimSpace(paired), "\n"), "connected": strings.Split(strings.TrimSpace(connected), "\n"), "controlAvailable": bluetoothControlAvailable()})
	})
}
