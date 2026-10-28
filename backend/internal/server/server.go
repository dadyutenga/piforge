package server

import (
	"crypto/subtle"
	"database/sql"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"piforge/backend/internal/store"
	"piforge/backend/internal/system"
	"piforge/backend/internal/workspace"
)

type Config struct {
	Address   string
	StaticDir string
	Secure    bool
}

type attempt struct {
	count int
	since time.Time
}

type Server struct {
	App       *fiber.App
	Store     *store.Store
	Workspace *workspace.Workspace
	Sampler   *system.Sampler
	cfg       Config
	mu        sync.Mutex
	attempts  map[string]attempt
	termSlots chan struct{}
}

func New(cfg Config, db *store.Store, files *workspace.Workspace, metrics *system.Sampler) *Server {
	s := &Server{Store: db, Workspace: files, Sampler: metrics, cfg: cfg, attempts: make(map[string]attempt), termSlots: make(chan struct{}, 3)}
	app := fiber.New(fiber.Config{BodyLimit: 32 << 20, DisableStartupMessage: true, ErrorHandler: func(c *fiber.Ctx, err error) error {
		var e *fiber.Error
		if errors.As(err, &e) {
			return c.Status(e.Code).JSON(fiber.Map{"error": e.Message})
		}
		slog.Error("request failed", "path", c.Path(), "error", err)
		return c.Status(500).JSON(fiber.Map{"error": "Internal error"})
	}})
	s.App = app
	app.Use(recover.New())
	app.Use(func(c *fiber.Ctx) error {
		c.Set("X-Content-Type-Options", "nosniff")
		c.Set("Referrer-Policy", "same-origin")
		c.Set("X-Frame-Options", "DENY")
		c.Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'")
		return c.Next()
	})
	app.Get("/api/bootstrap", func(c *fiber.Ctx) error {
		has, err := db.HasAdmin()
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"initialized": has})
	})
	app.Post("/api/login", s.login)
	app.Use(func(c *fiber.Ctx) error {
		if strings.HasPrefix(c.Path(), "/api/") {
			return s.requireSession(c)
		}
		return c.Next()
	})
	app.Get("/api/session", func(c *fiber.Ctx) error { return c.JSON(c.Locals("session")) })
	app.Post("/api/logout", s.logout)
	app.Post("/api/account/password", s.changePassword)
	app.Get("/api/system", func(c *fiber.Ctx) error { return c.JSON(metrics.Snapshot()) })
	app.Get("/api/capabilities", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"serviceControl": os.Getenv("PIFORGE_HELPER") != "", "wifiControl": wifiControlAvailable(), "bluetoothControl": bluetoothControlAvailable()})
	})
	app.Get("/api/activity", func(c *fiber.Ctx) error {
		events, err := db.Events(40)
		if err != nil {
			return err
		}
		return c.JSON(events)
	})
	s.registerFiles()
	s.registerSystem()
	s.registerWifiControl()
	s.registerBluetoothControl()
	s.registerTerminal()
	app.Use(func(c *fiber.Ctx) error {
		if strings.HasPrefix(c.Path(), "/api/") {
			return c.Status(404).JSON(fiber.Map{"error": "API endpoint not found"})
		}
		return c.Next()
	})
	app.Use("/ws", func(c *fiber.Ctx) error {
		return c.Status(404).JSON(fiber.Map{"error": "WebSocket endpoint not found"})
	})
	if cfg.StaticDir != "" {
		app.Static("/", cfg.StaticDir, fiber.Static{Compress: true, MaxAge: 0})
		app.Get("*", func(c *fiber.Ctx) error { return c.SendFile(filepath.Join(cfg.StaticDir, "index.html")) })
	}
	return s
}

func (s *Server) allowLogin(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.attempts) > 1024 {
		for k, v := range s.attempts {
			if time.Since(v.since) > 10*time.Minute {
				delete(s.attempts, k)
			}
		}
	}
	v := s.attempts[ip]
	if time.Since(v.since) > 10*time.Minute {
		v = attempt{since: time.Now()}
	}
	if v.count >= 5 {
		return false
	}
	v.count++
	s.attempts[ip] = v
	return true
}

func (s *Server) clearAttempts(ip string) { s.mu.Lock(); delete(s.attempts, ip); s.mu.Unlock() }

func (s *Server) login(c *fiber.Ctx) error {
	if !sameOrigin(c) {
		return c.Status(403).JSON(fiber.Map{"error": "Request origin is not allowed"})
	}
	if !s.allowLogin(c.IP()) {
		return c.Status(429).JSON(fiber.Map{"error": "Too many attempts. Try again later."})
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(400, "Invalid login request")
	}
	if len(req.Username) > 40 || len(req.Password) > 256 {
		return fiber.NewError(400, "Invalid login request")
	}
	token, session, err := s.Store.Login(req.Username, req.Password)
	if err != nil {
		_ = s.Store.Audit(req.Username, "login", "browser", false, "invalid credentials")
		if errors.Is(err, store.ErrCredentials) {
			return c.Status(401).JSON(fiber.Map{"error": "Invalid username or password"})
		}
		return err
	}
	s.clearAttempts(c.IP())
	c.Cookie(&fiber.Cookie{Name: "piforge_session", Value: token, Path: "/", HTTPOnly: true, Secure: s.cfg.Secure, SameSite: "Strict", Expires: time.Unix(session.Expires, 0)})
	_ = s.Store.Audit(session.Username, "login", "browser", true, "")
	return c.JSON(session)
}

func sameOrigin(c *fiber.Ctx) bool {
	origin := c.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, c.Get("Host")) && u.Scheme == c.Protocol()
}

func unsafe(method string) bool { return method != "GET" && method != "HEAD" && method != "OPTIONS" }

func (s *Server) requireSession(c *fiber.Ctx) error {
	token := c.Cookies("piforge_session")
	session, err := s.Store.GetSession(token)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			slog.Warn("session lookup failed", "error", err)
		}
		return c.Status(401).JSON(fiber.Map{"error": "Sign in to continue"})
	}
	if unsafe(c.Method()) {
		if !sameOrigin(c) {
			return c.Status(403).JSON(fiber.Map{"error": "Request origin is not allowed"})
		}
		csrf := c.Get("X-CSRF-Token")
		if subtle.ConstantTimeCompare([]byte(csrf), []byte(session.CSRF)) != 1 {
			return c.Status(403).JSON(fiber.Map{"error": "Security token is missing or expired"})
		}
	}
	c.Locals("session", session)
	c.Locals("username", session.Username)
	return c.Next()
}

func (s *Server) logout(c *fiber.Ctx) error {
	token := c.Cookies("piforge_session")
	if err := s.Store.Logout(token); err != nil {
		return err
	}
	c.Cookie(&fiber.Cookie{Name: "piforge_session", Value: "", Path: "/", HTTPOnly: true, Secure: s.cfg.Secure, SameSite: "Strict", Expires: time.Unix(0, 0)})
	_ = s.Store.Audit(c.Locals("username").(string), "logout", "browser", true, "")
	return c.SendStatus(204)
}

func (s *Server) changePassword(c *fiber.Ctx) error {
	var req struct {
		Current string `json:"current"`
		Next    string `json:"next"`
	}
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(400, "Invalid password request")
	}
	user := c.Locals("username").(string)
	err := s.Store.ChangePassword(user, req.Current, req.Next)
	s.audit(c, "account.password", user, err)
	if err != nil {
		if errors.Is(err, store.ErrCredentials) {
			return c.Status(403).JSON(fiber.Map{"error": "Current password is incorrect"})
		}
		return c.Status(400).JSON(fiber.Map{"error": err.Error()})
	}
	c.Cookie(&fiber.Cookie{Name: "piforge_session", Value: "", Path: "/", HTTPOnly: true, Secure: s.cfg.Secure, SameSite: "Strict", Expires: time.Unix(0, 0)})
	return c.SendStatus(204)
}

func (s *Server) audit(c *fiber.Ctx, action, target string, err error) {
	user, _ := c.Locals("username").(string)
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	if e := s.Store.Audit(user, action, target, err == nil, detail); e != nil {
		slog.Warn("audit write failed", "error", e)
	}
}

func (s *Server) Listen() error {
	if s.cfg.Secure {
		cert := os.Getenv("PIFORGE_TLS_CERT")
		key := os.Getenv("PIFORGE_TLS_KEY")
		if cert == "" || key == "" {
			return errors.New("TLS certificate and key are required for secure mode")
		}
		return s.App.ListenTLS(s.cfg.Address, cert, key)
	}
	return s.App.Listen(s.cfg.Address)
}
