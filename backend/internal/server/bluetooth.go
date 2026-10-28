package server

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"regexp"
	"time"

	"github.com/gofiber/fiber/v2"
)

var bluetoothAddress = regexp.MustCompile(`^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$`)

type bluetoothRequest struct {
	Action  string `json:"action"`
	Address string `json:"address,omitempty"`
}

type bluetoothResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func bluetoothControlAvailable() bool {
	path := os.Getenv("PIFORGE_BLUETOOTH_HELPER_SOCKET")
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode()&os.ModeSocket != 0
}

func callBluetoothHelper(req bluetoothRequest) (bluetoothResponse, error) {
	if !bluetoothControlAvailable() {
		return bluetoothResponse{}, errors.New("Bluetooth control is not installed or running")
	}
	conn, err := net.DialTimeout("unix", os.Getenv("PIFORGE_BLUETOOTH_HELPER_SOCKET"), 2*time.Second)
	if err != nil {
		return bluetoothResponse{}, errors.New("Bluetooth helper is unavailable")
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(50 * time.Second))
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return bluetoothResponse{}, errors.New("could not send Bluetooth request")
	}
	var result bluetoothResponse
	if err := json.NewDecoder(conn).Decode(&result); err != nil {
		return bluetoothResponse{}, errors.New("Bluetooth helper did not respond")
	}
	if result.Error != "" {
		return result, errors.New(result.Error)
	}
	return result, nil
}

func (s *Server) bluetoothMutation(c *fiber.Ctx, action, target string) error {
	result, err := callBluetoothHelper(bluetoothRequest{Action: action, Address: target})
	s.audit(c, "bluetooth."+action, target, err)
	if err != nil {
		code := 409
		if !bluetoothControlAvailable() {
			code = 503
		}
		return c.Status(code).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(result)
}

func (s *Server) registerBluetoothControl() {
	s.App.Post("/api/bluetooth/power", func(c *fiber.Ctx) error {
		var req struct {
			Enabled *bool `json:"enabled"`
		}
		if err := c.BodyParser(&req); err != nil || req.Enabled == nil {
			return fiber.NewError(400, "Invalid Bluetooth power request")
		}
		action := "power-off"
		if *req.Enabled {
			action = "power-on"
		}
		return s.bluetoothMutation(c, action, "adapter")
	})
	s.App.Post("/api/bluetooth/scan", func(c *fiber.Ctx) error { return s.bluetoothMutation(c, "scan", "adapter") })
	s.App.Post("/api/bluetooth/:action", func(c *fiber.Ctx) error {
		action := c.Params("action")
		if action != "pair" && action != "connect" && action != "disconnect" && action != "remove" {
			return fiber.NewError(400, "Unsupported Bluetooth action")
		}
		var req struct {
			Address string `json:"address"`
		}
		if err := c.BodyParser(&req); err != nil || !bluetoothAddress.MatchString(req.Address) {
			return fiber.NewError(400, "Invalid Bluetooth device address")
		}
		return s.bluetoothMutation(c, action, req.Address)
	})
}
