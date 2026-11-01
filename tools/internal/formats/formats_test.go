package formats

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/wisborg/clack/tools/internal/jsonschema"
)

const root = "../../.."

func schemas(t *testing.T) (theme, manifest *jsonschema.Schema) {
	t.Helper()
	theme, err := LoadSchema(filepath.Join(root, "schema/theme-1.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err = LoadSchema(filepath.Join(root, "schema/manifest-1.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	return theme, manifest
}

func builtins(t *testing.T, schema *jsonschema.Schema) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, name := range Builtins {
		doc, errs := Load(schema, filepath.Join(root, "themes", name+".json"))
		for _, e := range errs {
			t.Errorf("themes/%s.json: %v", name, e)
		}
		out[name] = doc
	}
	if t.Failed() {
		t.FailNow()
	}
	return out
}

func TestThemesDirHoldsExactlyTheBuiltins(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(root, "themes", "*"))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, f := range files {
		got = append(got, strings.TrimSuffix(filepath.Base(f), ".json"))
	}
	want := slices.Clone(Builtins)
	sort.Strings(got)
	sort.Strings(want)
	if !slices.Equal(got, want) {
		t.Errorf("themes/ holds %v, want %v", got, want)
	}
}

// The names a theme may extend are the built-ins, in the schema as here.
func TestExtendsNamesTheBuiltins(t *testing.T) {
	raw := readJSON(t, "schema/theme-1.schema.json")
	enum := raw["properties"].(map[string]any)["extends"].(map[string]any)["enum"].([]any)
	var got []string
	for _, e := range enum {
		got = append(got, e.(string))
	}
	if !slices.Equal(got, Builtins) {
		t.Errorf("schema allows extends %v, want %v", got, Builtins)
	}
}

func TestBaseSetsEveryToken(t *testing.T) {
	themeSchema, _ := schemas(t)
	base := builtins(t, themeSchema)["base"]
	if _, ok := base["extends"]; ok {
		t.Error("base extends another theme; it is where every theme starts")
	}
	if base["scheme"] != "auto" {
		t.Error("base must follow the visitor's scheme")
	}
	raw := readJSON(t, "schema/theme-1.schema.json")
	skip := []string{"$schema", "format", "name", "description", "author", "extends"}
	var missing []string
	for _, path := range tokenPaths(raw, raw, "") {
		if slices.Contains(skip, strings.Split(path, "/")[1]) {
			continue
		}
		if lookup(base, path) == nil {
			missing = append(missing, path)
		}
	}
	if len(missing) > 0 {
		t.Errorf("base does not set %s", strings.Join(missing, ", "))
	}
}

// tokenPaths lists the path of every leaf value a theme can set, following
// the schema's properties through $refs and allOf.
func tokenPaths(rootSchema, s map[string]any, prefix string) []string {
	if ref, ok := s["$ref"].(string); ok {
		name := strings.TrimPrefix(ref, "#/$defs/")
		def := rootSchema["$defs"].(map[string]any)[name].(map[string]any)
		return tokenPaths(rootSchema, def, prefix)
	}
	props := map[string]any{}
	for _, sub := range anySlice(s["allOf"]) {
		sm := sub.(map[string]any)
		if ref, ok := sm["$ref"].(string); ok {
			name := strings.TrimPrefix(ref, "#/$defs/")
			sm = rootSchema["$defs"].(map[string]any)[name].(map[string]any)
		}
		if p, ok := sm["properties"].(map[string]any); ok {
			for k, v := range p {
				props[k] = v
			}
		}
	}
	if p, ok := s["properties"].(map[string]any); ok {
		for k, v := range p {
			if _, inherited := props[k]; !inherited || v != true {
				props[k] = v
			}
		}
	}
	if len(props) == 0 {
		return []string{prefix}
	}
	var out []string
	for k, v := range props {
		if sm, ok := v.(map[string]any); ok {
			out = append(out, tokenPaths(rootSchema, sm, prefix+"/"+k)...)
		} else {
			out = append(out, prefix+"/"+k)
		}
	}
	sort.Strings(out)
	return out
}

func anySlice(v any) []any {
	s, _ := v.([]any)
	return s
}

func lookup(doc map[string]any, path string) any {
	var cur any = doc
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[part]
	}
	return cur
}

func TestBuiltinsResolveAndAreReadable(t *testing.T) {
	themeSchema, _ := schemas(t)
	all := builtins(t, themeSchema)
	for _, name := range Builtins {
		resolved, err := ResolveBuiltin(name, all)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		// What a theme resolves to is itself a valid theme.
		for _, e := range themeSchema.Validate(toDoc(t, resolved)) {
			t.Errorf("%s, resolved: %v", name, e)
		}
		for _, e := range CheckContrast(resolved) {
			t.Errorf("%s: %v", name, e)
		}
	}
}

func TestResolve(t *testing.T) {
	themeSchema, _ := schemas(t)
	all := builtins(t, themeSchema)
	sheet, err := ResolveBuiltin("contact-sheet", all)
	if err != nil {
		t.Fatal(err)
	}
	// Its own values, Gallery's (which it extends), and base's beneath both.
	for path, want := range map[string]any{
		"/name":                      "Contact sheet",
		"/colors/light/canvas":       "#f4f2ec",
		"/colors/light/surface":      "#fbfbfa",
		"/colors/light/hairline":     "rgb(0 0 0 / 0.1)",
		"/layout/padding/inline/max": "72px",
		"/layout/padding/bottom/max": "20px",
		"/index/style":               "contact-sheet",
		"/index/rowHeight/max":       "260px",
	} {
		if got := lookup(sheet, path); got != want {
			t.Errorf("%s = %v, want %v", path, got, want)
		}
	}
	// What belongs to one file is not inherited.
	mine := map[string]any{"format": "clack-theme/1", "name": "Mine", "extends": "gallery"}
	r, _ := Resolve(mine, all)
	if _, ok := r["description"]; ok {
		t.Error("a theme inherited its parent's description")
	}
	if r["extends"] != "gallery" {
		t.Errorf("extends = %v", r["extends"])
	}
	// Only built-ins can be extended.
	if _, err := Resolve(map[string]any{"extends": "elsewhere"}, all); err == nil {
		t.Error("resolved a theme that extends no built-in")
	}
}

func TestExamples(t *testing.T) {
	themeSchema, manifestSchema := schemas(t)
	for _, name := range []string{"manifest.json", "manifest-minimal.json"} {
		doc, errs := Load(manifestSchema, filepath.Join(root, "schema/examples", name))
		errs = append(errs, CheckManifest(doc)...)
		for _, e := range errs {
			t.Errorf("%s: %v", name, e)
		}
	}
	doc, errs := Load(themeSchema, filepath.Join(root, "schema/examples/theme-annotated.json"))
	for _, e := range errs {
		t.Errorf("theme-annotated.json: %v", e)
	}
	resolved, err := Resolve(doc, builtins(t, themeSchema))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range CheckContrast(resolved) {
		t.Errorf("theme-annotated.json: %v", e)
	}
}

// edit returns a copy of an example with the change applied: set is a map
// from a path to a new value (nil deletes it).
func edit(t *testing.T, example string, set map[string]any) []byte {
	t.Helper()
	doc := readJSON(t, example)
	for path, v := range set {
		parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
		var cur any = doc
		for _, p := range parts[:len(parts)-1] {
			switch c := cur.(type) {
			case map[string]any:
				if c[p] == nil {
					c[p] = map[string]any{}
				}
				cur = c[p]
			case []any:
				var i int
				json.Unmarshal([]byte(p), &i)
				cur = c[i]
			}
		}
		last := parts[len(parts)-1]
		switch c := cur.(type) {
		case map[string]any:
			if v == nil {
				delete(c, last)
			} else {
				c[last] = v
			}
		case []any:
			var i int
			json.Unmarshal([]byte(last), &i)
			c[i] = v
		default:
			t.Fatalf("%s: no such path", path)
		}
	}
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestThemeRefusals(t *testing.T) {
	themeSchema, _ := schemas(t)
	for name, c := range map[string]struct {
		path string
		set  map[string]any
	}{
		"a url() colour":                  {"/colors/light/canvas", map[string]any{"/colors/light/canvas": "url(https://example.com/x.png)"}},
		"a CSS keyword colour":            {"/colors/light/canvas", map[string]any{"/colors/light/canvas": "red"}},
		"a colour with a comment":         {"/colors/light/canvas", map[string]any{"/colors/light/canvas": "#fff/**/"}},
		"a legacy rgb() colour":           {"/colors/light/canvas", map[string]any{"/colors/light/canvas": "rgb(0, 0, 0)"}},
		"a channel above 255":             {"/colors/light/canvas", map[string]any{"/colors/light/canvas": "rgb(256 0 0)"}},
		"var() in a colour":               {"/colors/light/canvas", map[string]any{"/colors/light/canvas": "var(--x)"}},
		"an unknown role":                 {"/colors/light/glow", map[string]any{"/colors/light/glow": "#fff"}},
		"a third scheme":                  {"/colors/sepia", map[string]any{"/colors/sepia": map[string]any{}}},
		"CSS smuggled in":                 {"/css", map[string]any{"/css": "body { display: none }"}},
		"extends a URL":                   {"/extends", map[string]any{"/extends": "https://example.com/theme.json"}},
		"a font to fetch":                 {"/fonts/serif", map[string]any{"/fonts": map[string]any{"serif": "https://fonts.example.com/x.woff2"}}},
		"a negative length":               {"/index/gap", map[string]any{"/index/gap": "-4px"}},
		"a calc() length":                 {"/index/gap", map[string]any{"/index/gap": "calc(100vw - 1px)"}},
		"a length with no unit":           {"/index/gap", map[string]any{"/index/gap": "8"}},
		"an incomplete clamp":             {"/index/rowHeight", map[string]any{"/caption/size": "17px", "/index/rowHeight": map[string]any{"min": "1px"}}},
		"a huge caption":                  {"/caption/size", map[string]any{"/caption/size": "200px"}},
		"a slow transition":               {"/transition/duration", map[string]any{"/transition": map[string]any{"duration": "10s"}}},
		"an unknown layout":               {"/layout/type", map[string]any{"/layout": map[string]any{"type": "carousel"}}},
		"the next format":                 {"/format", map[string]any{"/format": "clack-theme/2"}},
		"no name":                         {"(document)", map[string]any{"/name": nil}},
		"a forced scheme's other colours": {"/colors", map[string]any{"/scheme": "dark"}},
	} {
		data := edit(t, "schema/examples/theme-annotated.json", c.set)
		_, errs := Parse(themeSchema, data)
		wantError(t, name, c.path, errs)
	}
}

func TestManifestRefusals(t *testing.T) {
	_, manifestSchema := schemas(t)
	for name, c := range map[string]struct {
		path string
		set  map[string]any
	}{
		"a javascript: URL":        {"/slides/0/page", map[string]any{"/slides/0/page": "javascript:alert(1)"}},
		"an upper-case scheme":     {"/slides/0/page", map[string]any{"/slides/0/page": "JavaScript:alert(1)"}},
		"a data: URL":              {"/slides/0/sources/0/url", map[string]any{"/slides/0/sources/0/url": "data:image/png;base64,AAAA"}},
		"a blob: URL":              {"/slides/0/full/url", map[string]any{"/slides/0/full/url": "blob:https://example.com/1"}},
		"a URL with a space":       {"/slides/0/sources/0/url", map[string]any{"/slides/0/sources/0/url": "a b.jpg"}},
		"a scheme-less colon":      {"/slides/0/sources/0/url", map[string]any{"/slides/0/sources/0/url": "x:y.jpg"}},
		"no alt":                   {"/slides/0", map[string]any{"/slides/0/alt": nil}},
		"no sources":               {"/slides/0/sources", map[string]any{"/slides/0/sources": []any{}}},
		"no size":                  {"/slides/1", map[string]any{"/slides/1/width": nil}},
		"a zero width":             {"/slides/1/width", map[string]any{"/slides/1/width": 0}},
		"an id with a slash":       {"/slides/0/id", map[string]any{"/slides/0/id": "a/b"}},
		"a thirteenth month":       {"/slides/0/time/taken", map[string]any{"/slides/0/time/taken": "2014-13-01"}},
		"a free-form date":         {"/slides/0/time/taken", map[string]any{"/slides/0/time/taken": "June 2014"}},
		"a latitude alone":         {"/slides/0/location", map[string]any{"/slides/0/location": map[string]any{"latitude": 51.5}}},
		"a latitude off the globe": {"/slides/0/location/latitude", map[string]any{"/slides/0/location/latitude": 91}},
		"metadata in no class":     {"/slides/0/gps", map[string]any{"/slides/0/gps": "51.5,-0.1"}},
		"an unknown camera field":  {"/slides/0/camera/serial", map[string]any{"/slides/0/camera/serial": "123"}},
		"a markup type":            {"/slides/0/sources/0/type", map[string]any{"/slides/0/sources/0/type": "image/svg+xml"}},
		"an unknown slide type":    {"/slides/0/type", map[string]any{"/slides/0/type": "html"}},
		"presentation in content":  {"/autoplay", map[string]any{"/autoplay": true}},
		"the next format":          {"/format", map[string]any{"/format": "clack-manifest/2"}},
	} {
		data := edit(t, "schema/examples/manifest.json", c.set)
		_, errs := Parse(manifestSchema, data)
		wantError(t, name, c.path, errs)
	}
}

// wantError checks that a document was refused, and for the reason the test
// meant: an error at path, not one it provoked by accident elsewhere.
func wantError(t *testing.T, name, path string, errs []error) {
	t.Helper()
	if len(errs) == 0 {
		t.Errorf("%s: accepted", name)
		return
	}
	var msgs []string
	for _, e := range errs {
		msgs = append(msgs, e.Error())
		if strings.HasPrefix(e.Error(), path+": ") {
			continue
		}
		t.Errorf("%s: an error elsewhere than %s: %v", name, path, e)
	}
	if !slices.ContainsFunc(msgs, func(m string) bool { return strings.HasPrefix(m, path+": ") }) {
		t.Errorf("%s: no error at %s, got %v", name, path, msgs)
	}
}

func TestCheckManifest(t *testing.T) {
	_, manifestSchema := schemas(t)
	data := edit(t, "schema/examples/manifest.json", map[string]any{"/slides/1/id": "low-tide"})
	doc, errs := Parse(manifestSchema, data)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	if got := CheckManifest(doc); len(got) != 1 || !strings.Contains(got[0].Error(), "/slides/1/id") {
		t.Errorf("repeated id: got %v", got)
	}
	data = edit(t, "schema/examples/manifest.json", map[string]any{"/slides/0/sources/1/width": 640})
	doc, _ = Parse(manifestSchema, data)
	if got := CheckManifest(doc); len(got) != 1 || !strings.Contains(got[0].Error(), "/slides/0/sources/1") {
		t.Errorf("repeated source: got %v", got)
	}
}

func TestParseColor(t *testing.T) {
	for in, want := range map[string]RGBA{
		"#fff":               {1, 1, 1, 1},
		"#000f":              {0, 0, 0, 1},
		"#ff000080":          {1, 0, 0, 128.0 / 255},
		"#1D1D1F":            {29.0 / 255, 29.0 / 255, 31.0 / 255, 1},
		"rgb(0 0 0 / 0.55)":  {0, 0, 0, 0.55},
		"rgb(255 0 0 / 50%)": {1, 0, 0, 0.5},
		"rgb(0 128 255)":     {0, 128.0 / 255, 1, 1},
	} {
		got, err := ParseColor(in)
		if err != nil {
			t.Errorf("%s: %v", in, err)
			continue
		}
		if math.Abs(got.R-want.R)+math.Abs(got.G-want.G)+math.Abs(got.B-want.B)+math.Abs(got.A-want.A) > 1e-9 {
			t.Errorf("%s = %+v, want %+v", in, got, want)
		}
	}
	for _, bad := range []string{"red", "#ff", "rgb(256 0 0)", "rgb(0 0 0 / 2)", "rgb(0,0,0)"} {
		if _, err := ParseColor(bad); err == nil {
			t.Errorf("%s: parsed", bad)
		}
	}
}

func TestContrast(t *testing.T) {
	white, black := RGBA{1, 1, 1, 1}, RGBA{0, 0, 0, 1}
	grey, _ := ParseColor("#777777")
	for _, c := range []struct {
		fg, bg RGBA
		want   float64
	}{
		{black, white, 21},
		{white, black, 21},
		{white, white, 1},
		{grey, white, 4.48},               // the classic just-too-light grey
		{RGBA{0, 0, 0, 0.5}, white, 3.98}, // composited first: #808080 on white
	} {
		if got := Contrast(c.fg, c.bg); math.Abs(got-c.want) > 0.01 {
			t.Errorf("Contrast(%+v, %+v) = %.3f, want %.2f", c.fg, c.bg, got, c.want)
		}
	}
	// A theme that falls short is told which pair, in which scheme.
	theme := map[string]any{"scheme": "light", "colors": map[string]any{"light": map[string]any{
		"canvas": "#ffffff", "surface": "#ffffff", "text": "#777777", "muted": "#000000",
		"accent": "#000000", "control": "#000000", "controlActive": "#000000",
		"label": "#ffffff", "labelText": "#000000", "labelMuted": "#000000",
		"film": "#000000", "edgePrint": "rgb(255 255 255 / 0.3)",
	}}}
	var msgs []string
	for _, e := range CheckContrast(theme) {
		msgs = append(msgs, e.Error())
	}
	got := strings.Join(msgs, "; ")
	for _, want := range []string{"light: text on canvas is 4.48:1", "light: text on surface", "light: edgePrint on film"} {
		if !strings.Contains(got, want) {
			t.Errorf("want %q in %q", want, got)
		}
	}
	if len(msgs) != 3 {
		t.Errorf("got %d problems, want 3: %s", len(msgs), got)
	}
}

func readJSON(t *testing.T, rel string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	doc, errs := Parse(mustCompile(t, `{}`), data)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	return doc
}

func mustCompile(t *testing.T, s string) *jsonschema.Schema {
	t.Helper()
	c, err := jsonschema.Compile([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// toDoc round-trips a value through JSON, so it has the types Validate
// expects (json.Number for numbers).
func toDoc(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := jsonschema.Decode(data)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

// patternsIn finds every pattern keyword in a schema, by the JSON Pointer of
// the schema that holds it.
func patternsIn(v any, pointer string, found map[string]string) {
	switch x := v.(type) {
	case map[string]any:
		for k, sub := range x {
			if s, ok := sub.(string); ok && k == "pattern" {
				found[pointer] = s
				continue
			}
			patternsIn(sub, pointer+"/"+strings.ReplaceAll(strings.ReplaceAll(k, "~", "~0"), "/", "~1"), found)
		}
	case []any:
		for i, sub := range x {
			patternsIn(sub, fmt.Sprintf("%s/%d", pointer, i), found)
		}
	}
}

// The same fixture is checked in every browser by test/schemas.test.ts, so
// Go and JavaScript are held to the same reading of each pattern.
func TestPatterns(t *testing.T) {
	fixture := readJSON(t, "test/fixtures/patterns.json")
	covered := map[string]bool{}
	for _, file := range []string{"theme-1.schema.json", "manifest-1.schema.json"} {
		raw := readJSON(t, "schema/"+file)
		found := map[string]string{}
		patternsIn(raw, "", found)
		for pointer, src := range found {
			key := file + "#" + pointer
			covered[key] = true
			re, err := regexp.Compile(src)
			if err != nil {
				t.Errorf("%s: %v", key, err)
				continue
			}
			// The schema's own examples are of the right form.
			node, _ := lookupPointer(raw, pointer).(map[string]any)
			for _, ex := range anySlice(node["examples"]) {
				if s, ok := ex.(string); ok && !re.MatchString(s) {
					t.Errorf("%s: its example %q does not match", key, s)
				}
			}
			cases, ok := fixture[key].(map[string]any)
			if !ok {
				t.Errorf("%s: no cases in test/fixtures/patterns.json", key)
				continue
			}
			for _, s := range anySlice(cases["match"]) {
				if !re.MatchString(s.(string)) {
					t.Errorf("%s: refused %q", key, s)
				}
			}
			for _, s := range anySlice(cases["nomatch"]) {
				if re.MatchString(s.(string)) {
					t.Errorf("%s: accepted %q", key, s)
				}
			}
		}
	}
	for key := range fixture {
		if !strings.HasPrefix(key, "$") && !covered[key] {
			t.Errorf("test/fixtures/patterns.json: %s names no pattern", key)
		}
	}
}

func lookupPointer(doc any, pointer string) any {
	cur := doc
	for _, part := range strings.Split(pointer, "/")[1:] {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		switch c := cur.(type) {
		case map[string]any:
			cur = c[part]
		case []any:
			var i int
			fmt.Sscan(part, &i)
			cur = c[i]
		default:
			return nil
		}
	}
	return cur
}
