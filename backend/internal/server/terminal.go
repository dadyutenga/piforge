package server

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
)

type terminalMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

func (s *Server) registerTerminal() {
	s.App.Use("/ws", func(c *fiber.Ctx) error {
		if c.Get("Origin") == "" || !sameOrigin(c) {
			return c.Status(403).JSON(fiber.Map{"error": "WebSocket origin is not allowed"})
		}
		session, err := s.Store.GetSession(c.Cookies("piforge_session"))
		if err != nil {
			return c.Status(401).JSON(fiber.Map{"error": "Sign in to open a terminal"})
		}
		if !websocket.IsWebSocketUpgrade(c) {
			return c.SendStatus(426)
		}
		c.Locals("username", session.Username)
		return c.Next()
	})
	s.App.Get("/ws/terminal", websocket.New(func(conn *websocket.Conn) {
		select {
		case s.termSlots <- struct{}{}:
			defer func() { <-s.termSlots }()
		default:
			_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"Terminal session limit reached"}`))
			return
		}
		cmd := exec.Command("/bin/bash", "-l")
		cmd.Dir = s.Workspace.Path
		cmd.Env = append(os.Environ(), "TERM=xterm-256color")
		ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 30, Cols: 100})
		if err != nil {
			_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"Unable to start shell"}`))
			return
		}
		user, _ := conn.Locals("username").(string)
		_ = s.Store.Audit(user, "terminal.open", "shell", true, "")
		var writes sync.Mutex
		var done sync.Once
		closeAll := func() {
			done.Do(func() {
				_ = conn.Close()
				_ = ptmx.Close()
				if cmd.Process != nil {
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
					_ = cmd.Process.Kill()
				}
			})
		}
		defer func() { closeAll(); _ = cmd.Wait(); _ = s.Store.Audit(user, "terminal.close", "shell", true, "") }()
		conn.SetReadLimit(64 << 10)
		go func() {
			buf := make([]byte, 8192)
			for {
				n, e := ptmx.Read(buf)
				if n > 0 {
					writes.Lock()
					writeErr := conn.WriteMessage(websocket.BinaryMessage, buf[:n])
					writes.Unlock()
					if writeErr != nil {
						break
					}
				}
				if e != nil {
					break
				}
			}
			closeAll()
		}()
		for {
			_, payload, err := conn.ReadMessage()
			if err != nil {
				break
			}
			var message terminalMessage
			if json.Unmarshal(payload, &message) != nil {
				continue
			}
			switch message.Type {
			case "input":
				if len(message.Data) <= 65536 {
					_, _ = io.WriteString(ptmx, message.Data)
				}
			case "resize":
				if message.Cols >= 20 && message.Cols <= 400 && message.Rows >= 5 && message.Rows <= 200 {
					_ = pty.Setsize(ptmx, &pty.Winsize{Cols: message.Cols, Rows: message.Rows})
				}
			}
		}
	}))
}
