package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

var ErrCredentials = errors.New("invalid credentials")

type Store struct{ db *sql.DB }

type Session struct {
	Username string `json:"username"`
	CSRF     string `json:"csrf"`
	Expires  int64  `json:"expires"`
}

type Event struct {
	ID      int64  `json:"id"`
	At      string `json:"at"`
	Actor   string `json:"actor"`
	Action  string `json:"action"`
	Target  string `json:"target"`
	Success bool   `json:"success"`
	Detail  string `json:"detail"`
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	for _, q := range []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash BLOB NOT NULL, created_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username), csrf TEXT NOT NULL, expires INTEGER NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires)`,
		`CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, success INTEGER NOT NULL, detail TEXT NOT NULL)`,
	} {
		if _, err := db.Exec(q); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) HasAdmin() (bool, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	return count > 0, err
}

func (s *Store) CreateAdmin(username, password string) error {
	if len(username) < 2 || len(username) > 40 || len(password) < 12 {
		return errors.New("username or password is too short")
	}
	for _, r := range username {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return errors.New("username contains invalid characters")
		}
	}
	has, err := s.HasAdmin()
	if err != nil {
		return err
	}
	if has {
		return errors.New("an admin already exists")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)`, username, hash, time.Now().UTC().Format(time.RFC3339))
	return err
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func tokenHash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func (s *Store) Login(username, password string) (string, Session, error) {
	var hash []byte
	err := s.db.QueryRow(`SELECT password_hash FROM users WHERE username=?`, username).Scan(&hash)
	if err != nil || bcrypt.CompareHashAndPassword(hash, []byte(password)) != nil {
		return "", Session{}, ErrCredentials
	}
	token, err := randomToken()
	if err != nil {
		return "", Session{}, err
	}
	csrf, err := randomToken()
	if err != nil {
		return "", Session{}, err
	}
	expires := time.Now().Add(12 * time.Hour).Unix()
	_, err = s.db.Exec(`INSERT INTO sessions(token_hash,username,csrf,expires) VALUES(?,?,?,?)`, tokenHash(token), username, csrf, expires)
	return token, Session{Username: username, CSRF: csrf, Expires: expires}, err
}

func (s *Store) GetSession(token string) (Session, error) {
	if len(token) != 64 {
		return Session{}, sql.ErrNoRows
	}
	var session Session
	err := s.db.QueryRow(`SELECT username,csrf,expires FROM sessions WHERE token_hash=? AND expires>?`, tokenHash(token), time.Now().Unix()).Scan(&session.Username, &session.CSRF, &session.Expires)
	return session, err
}

func (s *Store) Logout(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token_hash=?`, tokenHash(token))
	return err
}

func (s *Store) ChangePassword(username, current, next string) error {
	if len(next) < 12 || len(next) > 256 {
		return errors.New("new password must be 12–256 characters")
	}
	var hash []byte
	if err := s.db.QueryRow(`SELECT password_hash FROM users WHERE username=?`, username).Scan(&hash); err != nil {
		return ErrCredentials
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(current)) != nil {
		return ErrCredentials
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(next), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE users SET password_hash=? WHERE username=?`, newHash, username); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM sessions WHERE username=?`, username); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) PruneSessions() error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE expires<=?`, time.Now().Unix())
	return err
}

func (s *Store) Audit(actor, action, target string, success bool, detail string) error {
	if len(detail) > 300 {
		detail = detail[:300]
	}
	_, err := s.db.Exec(`INSERT INTO audit(at,actor,action,target,success,detail) VALUES(?,?,?,?,?,?)`, time.Now().UTC().Format(time.RFC3339), actor, action, target, success, detail)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`DELETE FROM audit WHERE id < (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET 4999)`)
	return err
}

func (s *Store) Events(limit int) ([]Event, error) {
	if limit < 1 || limit > 100 {
		limit = 30
	}
	rows, err := s.db.Query(`SELECT id,at,actor,action,target,success,detail FROM audit ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := make([]Event, 0, limit)
	for rows.Next() {
		var e Event
		var ok int
		if err := rows.Scan(&e.ID, &e.At, &e.Actor, &e.Action, &e.Target, &ok, &e.Detail); err != nil {
			return nil, err
		}
		e.Success = ok != 0
		events = append(events, e)
	}
	return events, rows.Err()
}
