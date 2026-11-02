package formats

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/wisborg/clack/tools/internal/jsonschema"
)

// The fuzz targets run their seeds with every `go test`; to search further:
//
//	go test ./tools/internal/formats -fuzz=FuzzManifest -fuzztime=60s
//	go test ./tools/internal/formats -fuzz=FuzzTheme -fuzztime=60s
//
// A crash found is written to testdata/fuzz/ and becomes a regression test.

func seed(f *testing.F, files ...string) {
	for _, name := range files {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			f.Fatal(err)
		}
		f.Add(data)
	}
	for _, s := range []string{"", "{", "null", "[]", `{"format":"clack-manifest/1","slides":[{}]}`, "/* */ {}", "// x\n{}", `"\u0000"`} {
		f.Add([]byte(s))
	}
}

// Checking a manifest never panics and never hangs, whatever the bytes, and
// a manifest it accepts survives being written out and read again.
func FuzzManifest(f *testing.F) {
	seed(f, "schema/examples/manifest.json", "schema/examples/manifest-minimal.json")
	// The shared cases' documents, as seeds of their own.
	raw, err := os.ReadFile(filepath.Join(root, "test/fixtures/manifests.json"))
	if err != nil {
		f.Fatal(err)
	}
	f.Add(raw)
	_, schema := schemasF(f)
	f.Fuzz(func(t *testing.T, data []byte) {
		doc, errs := ParseManifest(schema, data)
		if doc == nil {
			return
		}
		errs = append(errs, CheckManifest(doc)...)
		if len(errs) > 0 {
			return
		}
		again, err := json.Marshal(doc)
		if err != nil {
			t.Fatalf("an accepted manifest cannot be written out: %v", err)
		}
		if _, errs := ParseManifest(schema, again); len(errs) > 0 {
			t.Fatalf("an accepted manifest, written out and read again, is refused: %v", errs)
		}
	})
}

// Checking and resolving a theme never panics, whatever the bytes.
func FuzzTheme(f *testing.F) {
	seed(f, "themes/base.json", "themes/mat.json", "themes/darkroom.json", "schema/examples/theme-annotated.json")
	schema, _ := schemasF(f)
	builtins := map[string]map[string]any{}
	for _, name := range Builtins {
		doc, errs := Load(schema, filepath.Join(root, "themes", name+".json"))
		if len(errs) > 0 {
			f.Fatal(errs)
		}
		builtins[name] = doc
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		doc, errs := Parse(schema, data)
		if doc == nil || len(errs) > 0 {
			return
		}
		resolved, err := Resolve(doc, builtins)
		if err != nil {
			return
		}
		CheckContrast(resolved)
	})
}

func schemasF(f *testing.F) (theme, manifest *jsonschema.Schema) {
	theme, err := LoadSchema(filepath.Join(root, "schema/theme-1.schema.json"))
	if err != nil {
		f.Fatal(err)
	}
	manifest, err = LoadSchema(filepath.Join(root, "schema/manifest-1.schema.json"))
	if err != nil {
		f.Fatal(err)
	}
	return theme, manifest
}
