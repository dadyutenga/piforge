package server

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
)

type wifiRequest struct {
	Action   string `json:"action"`
	SSID     string `json:"ssid,omitempty"`
	Password string `json:"password,omitempty"`
	Hidden   bool   `json:"hidden,omitempty"`
	UUID     string `json:"uuid,omitempty"`
	ID       string `json:"id,omitempty"`
}

type wifiResponse struct {
	OK      bool            `json:"ok"`
	Error   string          `json:"error,omitempty"`
	Pending json.RawMessage `json:"pending,omitempty"`
}

func wifiSocket() string { return os.Getenv("PIFORGE_WIFI_HELPER_SOCKET") }

func wifiControlAvailable() bool {
	path := wifiSocket()
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode()&os.ModeSocket != 0
}

func callWifiHelper(req wifiRequest) (wifiResponse, error) {
	if !wifiControlAvailable() {
		return wifiResponse{}, errors.New("Wi-Fi control is not installed or running")
	}
	conn, err := net.DialTimeout("unix", wifiSocket(), 2*time.Second)
	if err != nil {
		return wifiResponse{}, errors.New("Wi-Fi helper is unavailable")
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(75 * time.Second))
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return wifiResponse{}, errors.New("could not send Wi-Fi request")
	}
	var response wifiResponse
	if err := json.NewDecoder(conn).Decode(&response); err != nil {
		return wifiResponse{}, errors.New("Wi-Fi helper did not respond")
	}
	if response.Error != "" {
		return response, errors.New(response.Error)
	}
	return response, nil
}

func (s *Server) wifiMutation(auditAction, target string, c *fiber.Ctx, req wifiRequest) error {
	result, err := callWifiHelper(req)
	s.audit(c, auditAction, target, err)
	if err != nil {
		status := 409
		if !wifiControlAvailable() {
			status = 503
		}
		return c.Status(status).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(result)
}

func (s *Server) registerWifiControl() {
	s.App.Post("/api/wifi/scan", func(c *fiber.Ctx) error {
		status, err := run(5*time.Second, "nmcli", "radio", "wifi")
		if err != nil || strings.TrimSpace(status) != "enabled" {
			return c.Status(409).JSON(fiber.Map{"error": "Turn Wi-Fi on before scanning"})
		}
		found, err := run(18*time.Second, "nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "yes", "ifname", "wlan0")
		s.audit(c, "wifi.scan", "wlan0", err)
		if err != nil {
			return c.Status(503).JSON(fiber.Map{"error": "Wi-Fi scan failed; try again shortly"})
		}
		return c.JSON(fiber.Map{"networks": found})
	})
	s.App.Get("/api/wifi/pending", func(c *fiber.Ctx) error {
		result, err := callWifiHelper(wifiRequest{Action: "status"})
		if err != nil {
			return c.Status(503).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(result)
	})
	s.App.Post("/api/wifi/connect", func(c *fiber.Ctx) error {
		var req struct {
			SSID     string `json:"ssid"`
			Password string `json:"password"`
			Hidden   bool   `json:"hidden"`
		}
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		if len(req.SSID) > 32 || len(req.Password) > 63 {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		return s.wifiMutation("wifi.connect", req.SSID, c, wifiRequest{Action: "connect", SSID: req.SSID, Password: req.Password, Hidden: req.Hidden})
	})
	s.App.Post("/api/wifi/activate", func(c *fiber.Ctx) error {
		var req struct {
			UUID string `json:"uuid"`
		}
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		if len(req.UUID) > 36 {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		return s.wifiMutation("wifi.activate", req.UUID, c, wifiRequest{Action: "activate", UUID: req.UUID})
	})
	s.App.Post("/api/wifi/disconnect", func(c *fiber.Ctx) error {
		return s.wifiMutation("wifi.disconnect", "wlan0", c, wifiRequest{Action: "disconnect"})
	})
	s.App.Post("/api/wifi/radio", func(c *fiber.Ctx) error {
		var req struct {
			Enabled *bool `json:"enabled"`
		}
		if err := c.BodyParser(&req); err != nil || req.Enabled == nil {
			return fiber.NewError(400, "Invalid Wi-Fi radio request")
		}
		action := "radio-off"
		if *req.Enabled {
			action = "radio-on"
		}
		return s.wifiMutation("wifi."+action, "wlan0", c, wifiRequest{Action: action})
	})
	s.App.Post("/api/wifi/forget", func(c *fiber.Ctx) error {
		var req struct {
			UUID string `json:"uuid"`
		}
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		if len(req.UUID) > 36 {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		return s.wifiMutation("wifi.forget", req.UUID, c, wifiRequest{Action: "forget", UUID: req.UUID})
	})
	s.App.Post("/api/wifi/confirm", func(c *fiber.Ctx) error {
		var req struct {
			ID string `json:"id"`
		}
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		if len(req.ID) > 24 {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		return s.wifiMutation("wifi.confirm", req.ID, c, wifiRequest{Action: "confirm", ID: req.ID})
	})
	s.App.Post("/api/wifi/revert", func(c *fiber.Ctx) error {
		var req struct {
			ID string `json:"id"`
		}
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		if len(req.ID) > 24 {
			return fiber.NewError(400, "Invalid Wi-Fi request")
		}
		return s.wifiMutation("wifi.revert", req.ID, c, wifiRequest{Action: "revert", ID: req.ID})
	})
}
