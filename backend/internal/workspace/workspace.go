package workspace

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const MaxTextBytes = 2 << 20

type Workspace struct {
	root *os.Root
	Path string
}

type Entry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Type     string `json:"type"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
}

func Open(path string) (*Workspace, error) {
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	return &Workspace{root: root, Path: path}, nil
}

func (w *Workspace) Close() error { return w.root.Close() }

func clean(path string, allowRoot bool) (string, error) {
	path = filepath.FromSlash(strings.TrimSpace(path))
	if path == "" || path == "." {
		if allowRoot {
			return ".", nil
		}
		return "", errors.New("a file path is required")
	}
	if !filepath.IsLocal(path) {
		return "", errors.New("path must stay inside the workspace")
	}
	if len(path) > 1024 {
		return "", errors.New("path is too long")
	}
	return filepath.Clean(path), nil
}

func fileType(info fs.FileInfo) string {
	if info.IsDir() {
		return "directory"
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "symlink"
	}
	return "file"
}

func (w *Workspace) List(path string) ([]Entry, error) {
	p, err := clean(path, true)
	if err != nil {
		return nil, err
	}
	f, err := w.root.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	items, err := f.ReadDir(500)
	if err != nil && err != io.EOF {
		return nil, err
	}
	out := make([]Entry, 0, len(items))
	for _, item := range items {
		info, e := item.Info()
		if e != nil {
			continue
		}
		child := item.Name()
		if p != "." {
			child = filepath.ToSlash(filepath.Join(p, child))
		}
		out = append(out, Entry{Name: item.Name(), Path: filepath.ToSlash(child), Type: fileType(info), Size: info.Size(), Modified: info.ModTime().UTC().Format(time.RFC3339)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type == "directory"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

func (w *Workspace) ReadText(path string) (string, error) {
	p, err := clean(path, false)
	if err != nil {
		return "", err
	}
	f, err := w.root.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("only regular files can be edited")
	}
	if info.Size() > MaxTextBytes {
		return "", errors.New("file is too large for the editor")
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxTextBytes+1))
	if err != nil {
		return "", err
	}
	if len(b) > MaxTextBytes {
		return "", errors.New("file is too large for the editor")
	}
	if strings.ContainsRune(string(b), '\x00') {
		return "", errors.New("binary files cannot be edited as text")
	}
	return string(b), nil
}

func (w *Workspace) WriteText(path, content string) error {
	p, err := clean(path, false)
	if err != nil {
		return err
	}
	if len(content) > MaxTextBytes {
		return errors.New("file is too large for the editor")
	}
	f, err := w.root.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	_, err = io.WriteString(f, content)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func (w *Workspace) Mkdir(path string) error {
	p, err := clean(path, false)
	if err != nil {
		return err
	}
	return w.root.Mkdir(p, 0700)
}

func (w *Workspace) Remove(path string) error {
	p, err := clean(path, false)
	if err != nil {
		return err
	}
	return w.root.RemoveAll(p)
}

func (w *Workspace) Rename(from, to string) error {
	a, err := clean(from, false)
	if err != nil {
		return err
	}
	b, err := clean(to, false)
	if err != nil {
		return err
	}
	if _, err := w.root.Lstat(b); err == nil {
		return errors.New("destination already exists")
	}
	return w.root.Rename(a, b)
}

func (w *Workspace) Copy(from, to string) error {
	a, err := clean(from, false)
	if err != nil {
		return err
	}
	b, err := clean(to, false)
	if err != nil {
		return err
	}
	src, err := w.root.Open(a)
	if err != nil {
		return err
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("copy supports regular files only")
	}
	if info.Size() > 100<<20 {
		return errors.New("file is too large to copy through PiForge")
	}
	dst, err := w.root.OpenFile(b, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, io.LimitReader(src, 100<<20))
	closeErr := dst.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func (w *Workspace) OpenDownload(path string) (*os.File, error) {
	p, err := clean(path, false)
	if err != nil {
		return nil, err
	}
	f, err := w.root.Open(p)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("not a regular file")
	}
	return f, nil
}

func (w *Workspace) SaveUpload(path string, source io.Reader) error {
	p, err := clean(path, false)
	if err != nil {
		return err
	}
	dst, err := w.root.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, io.LimitReader(source, 100<<20))
	closeErr := dst.Close()
	if err != nil {
		return err
	}
	return closeErr
}
