package bundle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestBuildInlinesCSSAsText(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.css", ":host { display: block; }")
	entry := write(t, dir, "a.ts", `import css from "./a.css";
export const sheet: string = css;
`)
	files, err := Build(Options{Entry: entry, Outfile: filepath.Join(dir, "out.js")})
	if err != nil {
		t.Fatal(err)
	}
	var js, mapFile string
	for _, f := range files {
		switch filepath.Base(f.Path) {
		case "out.js":
			js = string(f.Contents)
		case "out.js.map":
			mapFile = string(f.Contents)
		}
	}
	if !strings.Contains(js, ":host { display: block; }") {
		t.Errorf("the CSS is not in the bundle as text:\n%s", js)
	}
	if !strings.Contains(js, "sourceMappingURL=out.js.map") || mapFile == "" {
		t.Error("the bundle has no linked source map")
	}
	if _, err := os.Stat(filepath.Join(dir, "out.js")); err == nil {
		t.Error("Write was false, but the bundle was written to disk")
	}
}

func TestBuildTreatsWarningsAsErrors(t *testing.T) {
	dir := t.TempDir()
	// Comparing with -0 is one of esbuild's warnings.
	entry := write(t, dir, "w.ts", "export const z = (x: number) => x === -0;\n")
	if _, err := Build(Options{Entry: entry, Outfile: filepath.Join(dir, "w.js")}); err == nil {
		t.Fatal("want the warning to fail the build")
	}
}

func TestBuildReportsErrors(t *testing.T) {
	dir := t.TempDir()
	entry := write(t, dir, "e.ts", `import "./missing";`)
	_, err := Build(Options{Entry: entry, Outfile: filepath.Join(dir, "e.js")})
	if err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("err = %v, want an unresolved-import error", err)
	}
}

func TestMinifiedBuildMinifiesTheCSS(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.css", "/* a comment that must not ship */\n:host {\n  display: block;\n  color: light-dark(#ffffff, #000000);\n}\n")
	entry := write(t, dir, "a.ts", `import css from "./a.css";
export const sheet: string = css;
`)
	files, err := Build(Options{Entry: entry, Outfile: filepath.Join(dir, "out.js"), Minify: true})
	if err != nil {
		t.Fatal(err)
	}
	var js string
	for _, f := range files {
		if filepath.Base(f.Path) == "out.js" {
			js = string(f.Contents)
		}
	}
	if strings.Contains(js, "must not ship") {
		t.Errorf("the CSS comment is in the minified bundle:\n%s", js)
	}
	// light-dark() is in every engine Clack targets, so it is kept as it is.
	if !strings.Contains(js, ":host{display:block;color:light-dark(#ffffff,#000000)}") {
		t.Errorf("the CSS is not minified as expected:\n%s", js)
	}
}

func TestSchemasArriveWithoutAnnotations(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a.schema.json", `{"description": "only words", "properties": {"title": {"type": "string", "title": "T"}}}`)
	entry := write(t, dir, "a.ts", `import schema from "./a.schema.json";
export const s: unknown = schema;
`)
	files, err := Build(Options{Entry: entry, Outfile: filepath.Join(dir, "out.js"), Minify: true})
	if err != nil {
		t.Fatal(err)
	}
	var js string
	for _, f := range files {
		if filepath.Base(f.Path) == "out.js" {
			js = string(f.Contents)
		}
	}
	if strings.Contains(js, "only words") || !strings.Contains(js, `properties:{title:{type:"string"}}`) {
		t.Errorf("the schema is not stripped as expected:\n%s", js)
	}
	write(t, dir, "a.schema.json", `{"format": "email"}`)
	if _, err := Build(Options{Entry: entry, Outfile: filepath.Join(dir, "out.js")}); err == nil {
		t.Error("a schema the validator refuses was bundled")
	}
}

func TestThemesArriveWithoutWhatOnlyAPersonReads(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "themes"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, dir, "themes/a.json", `{"$schema": "../schema/x.json", "name": "A", "description": "only words", "scheme": "dark"}`)
	entry := write(t, dir, "a.ts", `import theme from "./themes/a.json";
export const s: unknown = theme;
`)
	files, err := Build(Options{Entry: entry, Outfile: filepath.Join(dir, "out.js"), Minify: true})
	if err != nil {
		t.Fatal(err)
	}
	var js string
	for _, f := range files {
		if filepath.Base(f.Path) == "out.js" {
			js = string(f.Contents)
		}
	}
	if strings.Contains(js, "only words") || strings.Contains(js, "schema/x.json") || !strings.Contains(js, `scheme:"dark"`) {
		t.Errorf("the theme is not stripped as expected:\n%s", js)
	}
}
