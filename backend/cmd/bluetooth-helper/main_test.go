package main

import "testing"

func TestBluetoothAddressValidation(t *testing.T) {
	for _, address := range []string{"AA:BB:CC:DD:EE:FF", "01:23:45:67:89:ab"} {
		if !addressPattern.MatchString(address) {
			t.Fatalf("rejected valid address %q", address)
		}
	}
	for _, address := range []string{"", "AA:BB:CC:DD:EE", "AA:BB:CC:DD:EE:FF;reboot", "AA:BB:CC:DD:EE:FF\n"} {
		if addressPattern.MatchString(address) {
			t.Fatalf("accepted invalid address %q", address)
		}
	}
}
