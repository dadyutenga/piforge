package server

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gofiber/fiber/v2"
)

type pathRequest struct {
	Path string `json:"path"`
}
type renameRequest struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func fileError(c *fiber.Ctx, err error) error {
	if os.IsNotExist(err) {
		return c.Status(404).JSON(fiber.Map{"error": "File or folder not found"})
	}
	if os.IsPermission(err) {
		return c.Status(403).JSON(fiber.Map{"error": "Permission denied"})
	}
	return c.Status(400).JSON(fiber.Map{"error": err.Error()})
}

func (s *Server) registerFiles() {
	s.App.Get("/api/files", func(c *fiber.Ctx) error {
		path := c.Query("path")
		entries, err := s.Workspace.List(path)
		if err != nil {
			return fileError(c, err)
		}
		return c.JSON(fiber.Map{"path": path, "entries": entries})
	})
	s.App.Get("/api/files/content", func(c *fiber.Ctx) error {
		path := c.Query("path")
		text, err := s.Workspace.ReadText(path)
		if err != nil {
			return fileError(c, err)
		}
		return c.JSON(fiber.Map{"path": path, "content": text})
	})
	s.App.Put("/api/files/content", func(c *fiber.Ctx) error {
		var req struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(400, "Invalid file request")
		}
		err := s.Workspace.WriteText(req.Path, req.Content)
		s.audit(c, "file.save", req.Path, err)
		if err != nil {
			return fileError(c, err)
		}
		return c.JSON(fiber.Map{"saved": true})
	})
	s.App.Post("/api/files/folder", func(c *fiber.Ctx) error {
		var req pathRequest
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(400, "Invalid folder request")
		}
		err := s.Workspace.Mkdir(req.Path)
		s.audit(c, "folder.create", req.Path, err)
		if err != nil {
			return fileError(c, err)
		}
		return c.Status(201).JSON(fiber.Map{"path": req.Path})
	})
	s.App.Post("/api/files/rename", func(c *fiber.Ctx) error {
		var req renameRequest
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(400, "Invalid rename request")
		}
		err := s.Workspace.Rename(req.From, req.To)
		s.audit(c, "file.rename", req.From, err)
		if err != nil {
			return fileError(c, err)
		}
		return c.JSON(fiber.Map{"path": req.To})
	})
	s.App.Post("/api/files/copy", func(c *fiber.Ctx) error {
		var req renameRequest
		if err := c.BodyParser(&req); err != nil {
			return fiber.NewError(400, "Invalid copy request")
		}
		err := s.Workspace.Copy(req.From, req.To)
		s.audit(c, "file.copy", req.From, err)
		if err != nil {
			return fileError(c, err)
		}
		return c.Status(201).JSON(fiber.Map{"path": req.To})
	})
	s.App.Delete("/api/files", func(c *fiber.Ctx) error {
		path := c.Query("path")
		if path == "" {
			return fiber.NewError(400, "A path is required")
		}
		err := s.Workspace.Remove(path)
		s.audit(c, "file.delete", path, err)
		if err != nil {
			return fileError(c, err)
		}
		return c.SendStatus(204)
	})
	s.App.Post("/api/files/upload", func(c *fiber.Ctx) error {
		file, err := c.FormFile("file")
		if err != nil {
			return fiber.NewError(400, "Choose a file to upload")
		}
		if file.Size > 32<<20 {
			return fiber.NewError(413, "Files must be 32 MB or smaller")
		}
		folder := c.FormValue("path")
		name := filepath.Base(file.Filename)
		if name == "." || name == "/" || strings.ContainsAny(name, "\\/") {
			return fiber.NewError(400, "Invalid file name")
		}
		path := filepath.ToSlash(filepath.Join(folder, name))
		src, err := file.Open()
		if err != nil {
			return err
		}
		defer src.Close()
		err = s.Workspace.SaveUpload(path, src)
		s.audit(c, "file.upload", path, err)
		if err != nil {
			return fileError(c, err)
		}
		return c.Status(201).JSON(fiber.Map{"path": path})
	})
	s.App.Get("/api/files/download", func(c *fiber.Ctx) error {
		path := c.Query("path")
		f, err := s.Workspace.OpenDownload(path)
		if err != nil {
			return fileError(c, err)
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			return err
		}
		name := filepath.Base(path)
		c.Set("Content-Type", "application/octet-stream")
		c.Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
		return c.SendStream(f, int(info.Size()))
	})
}
