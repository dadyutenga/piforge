package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"
	"piforge/backend/internal/server"
	"piforge/backend/internal/store"
	"piforge/backend/internal/system"
	"piforge/backend/internal/workspace"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func run() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dataDir := env("PIFORGE_DATA_DIR", filepath.Join(home, ".local", "share", "piforge"))
	db, err := store.Open(filepath.Join(dataDir, "piforge.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	if err := db.PruneSessions(); err != nil {
		return err
	}
	if len(os.Args) > 1 && os.Args[1] == "init-admin" {
		username := "dadi"
		if len(os.Args) > 2 {
			username = os.Args[2]
		}
		fmt.Print("New PiForge password (12+ characters): ")
		first, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return err
		}
		fmt.Print("Confirm password: ")
		second, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return err
		}
		if string(first) != string(second) {
			return errors.New("passwords do not match")
		}
		if err := db.CreateAdmin(username, string(first)); err != nil {
			return err
		}
		fmt.Println("PiForge admin created:", username)
		return nil
	}
	if len(os.Args) > 1 {
		return fmt.Errorf("unknown command: %s", os.Args[1])
	}
	hasAdmin, err := db.HasAdmin()
	if err != nil {
		return err
	}
	if !hasAdmin {
		return errors.New("no admin account; run piforge init-admin before starting the server")
	}
	files, err := workspace.Open(env("PIFORGE_WORKSPACE", filepath.Join(home, "PiForge")))
	if err != nil {
		return err
	}
	defer files.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	metrics := system.NewSampler(ctx)
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	secure := os.Getenv("PIFORGE_INSECURE_HTTP") != "1"
	address := "127.0.0.1:8787"
	if secure {
		address = "0.0.0.0:8787"
	}
	app := server.New(server.Config{Address: env("PIFORGE_ADDRESS", address), StaticDir: env("PIFORGE_STATIC_DIR", filepath.Join(filepath.Dir(executable), "static")), Secure: secure}, db, files, metrics)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)
	errCh := make(chan error, 1)
	go func() { errCh <- app.Listen() }()
	slog.Info("PiForge starting", "address", address, "secure", secure)
	select {
	case <-stop:
	case err := <-errCh:
		if err != nil {
			return err
		}
	}
	cancel()
	if err := app.App.ShutdownWithTimeout(5 * time.Second); err != nil && !strings.Contains(err.Error(), "closed") {
		return err
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		slog.Error("PiForge stopped", "error", err)
		os.Exit(1)
	}
}
