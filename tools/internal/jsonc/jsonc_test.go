package jsonc

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestStrip(t *testing.T) {
	for name, c := range map[string]struct{ in, want string }{
		"line comment":                {"{\"a\": 1 // one\n}", "{\"a\": 1       \n}"},
		"block comment":               {"{/* a\nb */\"a\": 1}", "{    \n    \"a\": 1}"},
		"slashes in a string":         {`{"url": "https://example.com/a//b"}`, `{"url": "https://example.com/a//b"}`},
		"comment markers in a string": {`{"a": "/* not */ // a comment"}`, `{"a": "/* not */ // a comment"}`},
		"escaped quote":               {`{"a": "say \"//\"" // c` + "\n}", `{"a": "say \"//\""     ` + "\n}"},
		"escaped backslash":           {`{"a": "\\" // c` + "\n}", `{"a": "\\"     ` + "\n}"},
		"comment at the end":          {"{}//", "{}  "},
		"lone slash":                  {"{} /", "{} /"},
	} {
		got, err := Strip([]byte(c.in))
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("%s:\n got %q\nwant %q", name, got, c.want)
		}
		if len(got) != len(c.in) {
			t.Errorf("%s: length changed", name)
		}
	}
}

func TestStripRefuses(t *testing.T) {
	for _, in := range []string{`{"a": "open`, `{"a": 1 /* open`, `{"a": "\`, "{/*/}"} {
		if _, err := Strip([]byte(in)); err == nil {
			t.Errorf("%q: want an error", in)
		}
	}
}

func TestStrippedIsJSON(t *testing.T) {
	in := `{
  // the theme's name
  "name": "Mine", /* shown in pickers */
  "url": "https://example.com/x" // not a comment inside
}`
	out, err := Strip([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]string
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatal(err)
	}
	if v["name"] != "Mine" || v["url"] != "https://example.com/x" {
		t.Errorf("got %v", v)
	}
}

// Stripping never panics, keeps the length, and keeps every newline where
// it was; text without comments comes back as it was.
func FuzzStrip(f *testing.F) {
	for _, s := range []string{"{}", `{"a": "//"} // c`, "/* a\nb */", `"\"`, "/*", "//\n//", `{"a":"\\"}`} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, in []byte) {
		out, err := Strip(in)
		if err != nil {
			return
		}
		if len(out) != len(in) {
			t.Fatalf("length %d, want %d", len(out), len(in))
		}
		for i := range in {
			if (in[i] == '\n') != (out[i] == '\n') {
				t.Fatalf("a newline moved at %d", i)
			}
		}
		if !bytes.Contains(in, []byte("/")) && !bytes.Equal(in, out) {
			t.Fatal("text without a slash changed")
		}
	})
}
