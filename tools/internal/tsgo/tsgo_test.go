package tsgo

import "testing"

func TestParseVersion(t *testing.T) {
	for _, tc := range []struct {
		out, want string
		ok        bool
	}{
		{"Version 7.0.2\n", "7.0.2", true},
		{"Version 7.1.0-beta", "7.1.0-beta", true},
		{"tsc 5.9.3", "", false},
		{"Version ", "", false},
		{"Version 7.0.2\nextra line", "", false},
	} {
		got, err := parseVersion(tc.out)
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("parseVersion(%q) = %q, %v; want %q, ok=%v", tc.out, got, err, tc.want, tc.ok)
		}
	}
}

func TestPinIsAFullCommitHash(t *testing.T) {
	// A short or symbolic pin would let the fetched source change under it.
	if len(Commit) != 40 {
		t.Fatalf("Commit %q is not a full 40-character hash", Commit)
	}
	for _, c := range Commit {
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f') {
			t.Fatalf("Commit %q is not lowercase hex", Commit)
		}
	}
}
