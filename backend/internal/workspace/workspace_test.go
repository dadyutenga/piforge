package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceFileLifecycle(t *testing.T) {
	w, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	if err := w.Mkdir("project"); err != nil {
		t.Fatal(err)
	}
	if err := w.WriteText("project/main.go", "package main\n"); err != nil {
		t.Fatal(err)
	}
	if err := w.Copy("project/main.go", "project/copy.go"); err != nil {
		t.Fatal(err)
	}
	if err := w.Rename("project/copy.go", "project/renamed.go"); err != nil {
		t.Fatal(err)
	}
	entries, err := w.List("project")
	if err != nil || len(entries) != 2 {
		t.Fatalf("list: %v, %#v", err, entries)
	}
	content, err := w.ReadText("project/renamed.go")
	if err != nil || content != "package main\n" {
		t.Fatalf("read: %v, %q", err, content)
	}
	if err := w.Remove("project"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.List("project"); !os.IsNotExist(err) {
		t.Fatalf("removed folder remains: %v", err)
	}
}

func TestWorkspaceRejectsEscape(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	w, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	if err := os.Symlink(outside, filepath.Join(base, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../secret.txt", "escape/secret.txt", "/etc/passwd"} {
		if _, err := w.ReadText(path); err == nil {
			t.Errorf("read escaped using %q", path)
		}
		if err := w.WriteText(path, "changed"); err == nil {
			t.Errorf("wrote outside using %q", path)
		}
	}
	if err := w.Remove("escape"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(secret)
	if err != nil || !strings.EqualFold(string(data), "private") {
		t.Fatalf("outside file changed: %v, %q", err, data)
	}
}
