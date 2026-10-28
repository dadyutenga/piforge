package main

import (
	"strings"
	"testing"
)

func TestNetworkInputValidation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		ssid  string
		valid bool
	}{
		{"ordinary", "Home Wi-Fi", true},
		{"empty", "", false},
		{"option-like", "--help", false},
		{"newline", "Home\nother", false},
		{"too long", strings.Repeat("a", 33), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validSSID(tc.ssid); got != tc.valid {
				t.Fatalf("validSSID(%q) = %v", tc.ssid, got)
			}
		})
	}
	for _, tc := range []struct {
		name     string
		password string
		valid    bool
	}{
		{"open network", "", true},
		{"WPA passphrase", "abcdefgh", true},
		{"too short", "1234567", false},
		{"too long", strings.Repeat("a", 64), false},
		{"newline", "abcdefgh\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := validPassword(tc.password); got != tc.valid {
				t.Fatalf("validPassword(%q) = %v", tc.password, got)
			}
		})
	}
}
