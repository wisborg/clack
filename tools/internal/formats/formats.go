// Package formats checks Clack's theme and manifest files: the built-in
// themes in themes/ and the examples in schema/examples/ against the
// published schemas, plus the rules a schema cannot state -- a theme's
// contrast, a manifest's unique slide ids.
//
// It is the reference the browser's loader (phase 1) is tested against: the
// same files, the same verdicts. It runs in the tools only; nothing here
// ships.
package formats

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/wisborg/clack/tools/internal/jsonc"
	"github.com/wisborg/clack/tools/internal/jsonschema"
	"github.com/wisborg/clack/tools/internal/thumbhash"
)

// Builtins are the themes Clack ships, by the name a theme extends them
// with. base is what every theme starts from.
var Builtins = []string{"base", "gallery", "darkroom", "mat", "minimal", "contact-sheet"}

// LoadSchema reads and compiles a schema file.
func LoadSchema(path string) (*jsonschema.Schema, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	s, err := jsonschema.Compile(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return s, nil
}

// Load reads a theme file -- comments allowed -- and validates it against
// schema, returning the document and every way it fails. Manifests, which
// allow no comments, have LoadManifest.
func Load(schema *jsonschema.Schema, path string) (map[string]any, []error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, []error{err}
	}
	return Parse(schema, data)
}

// Parse is Load for a theme already in memory: comments are allowed in a
// theme, which people write by hand.
func Parse(schema *jsonschema.Schema, data []byte) (map[string]any, []error) {
	stripped, err := jsonc.Strip(data)
	if err != nil {
		return nil, []error{err}
	}
	v, err := jsonschema.Decode(stripped)
	if err != nil {
		return nil, []error{err}
	}
	// As in a manifest (ParseManifest): every string well-formed Unicode,
	// here as in the browser. Comments are gone by now, so an escape in one
	// counts for nothing, there as here.
	if at := loneSurrogate(stripped); at >= 0 {
		return nil, []error{jsonschema.Error{Path: "", Message: fmt.Sprintf("has a string that is not well-formed Unicode (a lone surrogate escape at byte %d)", at)}}
	}
	return check(schema, v)
}

// MaxThemeBytes is the most a theme file may weigh, in the browser as in
// the tools: base, which sets every token, is under 3 KB, so a theme of 64
// KB is one with something in it that is not a theme.
const MaxThemeBytes = 64 << 10

// ParseTheme reads a theme file as Clack does in the browser (src/theme.ts),
// and returns it resolved onto the built-in it extends, or every way it
// fails: too large, not UTF-8, not JSON once its comments are removed,
// against the schema, in resolving, and in contrast -- each step only if
// the one before it passed, as there. builtins holds the built-in themes
// as loaded, by name.
func ParseTheme(schema *jsonschema.Schema, data []byte, builtins map[string]map[string]any) (map[string]any, []error) {
	if len(data) > MaxThemeBytes {
		return nil, []error{jsonschema.Error{Path: "", Message: fmt.Sprintf("is larger than %d bytes", MaxThemeBytes)}}
	}
	if !utf8.Valid(data) {
		return nil, []error{jsonschema.Error{Path: "", Message: "is not UTF-8"}}
	}
	doc, errs := Parse(schema, data)
	if len(errs) > 0 {
		return nil, errs
	}
	resolved, err := Resolve(doc, builtins)
	if err != nil {
		return nil, []error{err}
	}
	if errs := CheckContrast(resolved); len(errs) > 0 {
		return nil, errs
	}
	return resolved, nil
}

// LoadManifest reads a manifest file and checks it, as Clack does in the
// browser (src/manifest.ts): UTF-8 only, no byte-order mark, no comments,
// then CheckJSON and the schema. CheckManifest adds the rules beyond the
// schema.
func LoadManifest(schema *jsonschema.Schema, path string) (map[string]any, []error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, []error{err}
	}
	return ParseManifest(schema, data)
}

// ParseManifest is LoadManifest for a manifest already in memory.
func ParseManifest(schema *jsonschema.Schema, data []byte) (map[string]any, []error) {
	// The browser reads no more than this (src/manifest.ts maxBytes), so
	// neither do we: a manifest the tools pass is never refused by Clack.
	if len(data) > MaxBytes {
		return nil, []error{jsonschema.Error{Path: "", Message: fmt.Sprintf("is larger than %d bytes", MaxBytes)}}
	}
	// encoding/json would quietly turn bytes that are not UTF-8 into
	// U+FFFD; the browser refuses them, and so do we.
	if !utf8.Valid(data) {
		return nil, []error{jsonschema.Error{Path: "", Message: "is not UTF-8"}}
	}
	v, err := jsonschema.Decode(data)
	if err != nil {
		return nil, []error{err}
	}
	// More slides than a manifest may hold settle the verdict at once, and
	// the browser looks no further (src/manifest.ts checking): nor do we,
	// so the two report the same one place.
	if m, ok := v.(map[string]any); ok {
		if slides, ok := m["slides"].([]any); ok && len(slides) > MaxSlides {
			return nil, []error{jsonschema.Error{Path: "/slides", Message: fmt.Sprintf("must have at most %d items", MaxSlides)}}
		}
	}
	// encoding/json turns an escaped lone surrogate (\ud800 alone) into
	// U+FFFD, so two different keys could become one; the browser keeps
	// them apart. Every string must be well-formed Unicode, here as there;
	// found in the raw text, it is reported against the whole file, as
	// the browser reports it too.
	if at := loneSurrogate(data); at >= 0 {
		return nil, []error{jsonschema.Error{Path: "", Message: fmt.Sprintf("has a string that is not well-formed Unicode (a lone surrogate escape at byte %d)", at)}}
	}
	return check(schema, v)
}

// loneSurrogate returns the offset of the first \u escape in a JSON
// string that is half of a surrogate pair without its other half, or -1.
// Valid UTF-8 cannot hold a surrogate itself, so escapes are all there is
// to look at.
func loneSurrogate(data []byte) int {
	hex := func(b []byte) (int, bool) {
		if len(b) < 4 {
			return 0, false
		}
		n, err := strconv.ParseUint(string(b[:4]), 16, 32)
		return int(n), err == nil
	}
	inString := false
	for i := 0; i < len(data); i++ {
		c := data[i]
		switch {
		case !inString:
			if c == '"' {
				inString = true
			}
		case c == '"':
			inString = false
		case c == '\\' && i+1 < len(data):
			if data[i+1] != 'u' {
				i++ // a two-character escape
				continue
			}
			u, ok := hex(data[i+2:])
			if !ok {
				return -1 // not JSON: the decoder will say so
			}
			switch {
			case u >= 0xDC00 && u <= 0xDFFF:
				return i // a low half with no high half before it
			case u >= 0xD800 && u <= 0xDBFF:
				low, ok := -1, false
				if i+11 < len(data) && data[i+6] == '\\' && data[i+7] == 'u' {
					low, ok = hex(data[i+8:])
				}
				if !ok || low < 0xDC00 || low > 0xDFFF {
					return i // a high half with no low half after it
				}
				i += 11
			default:
				i += 5
			}
		}
	}
	return -1
}

// MaxBytes is the most a manifest may weigh, in the browser as in the
// tools: 20,000 slides of about 1.6 KB each, sources and full metadata.
const MaxBytes = 32 << 20

// MaxSlides is the most slides a manifest may hold: the schema's
// properties.slides.maxItems, which a test keeps it equal to.
const MaxSlides = 20000

// check is parse for a document already decoded.
func check(schema *jsonschema.Schema, v any) (map[string]any, []error) {
	var errs []error
	if shape := CheckJSON(v); len(shape) > 0 {
		for _, e := range shape {
			errs = append(errs, e)
		}
		return nil, errs
	}
	for _, e := range schema.Validate(v) {
		errs = append(errs, e)
	}
	doc, _ := v.(map[string]any)
	return doc, errs
}

// MaxDepth is how deeply a document's values may nest: far beyond any real
// theme or manifest. Clack in the browser has the same limit (src/rules.ts
// maxDepth). A document nested beyond encoding/json's own limit, 10,000,
// fails to decode here before this is checked, with no path, where the
// browser finds it too deep at a path: both refuse it.
const MaxDepth = 64

// CheckJSON returns what is wrong with a decoded document before any schema
// is consulted, as the browser checks it (src/manifest.ts checkJSON):
// values nested more than MaxDepth deep, and numbers too large to hold,
// which a browser's JSON.parse turns into Infinity. Sorted by place.
func CheckJSON(doc any) []jsonschema.Error {
	// Each value remembers its parent and its key; its path is spelt out
	// only for a value with a problem.
	type item struct {
		v      any
		parent *item
		key    string
		depth  int
	}
	var pathOf func(it *item) string
	pathOf = func(it *item) string {
		if it.parent == nil {
			return ""
		}
		return pathOf(it.parent) + "/" + jsonschema.EscapePointer(it.key)
	}
	var errs []jsonschema.Error
	stack := []*item{{v: doc, depth: 1}}
	for len(stack) > 0 {
		it := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		switch x := it.v.(type) {
		case json.Number:
			if f, err := x.Float64(); err != nil || math.IsInf(f, 0) {
				errs = append(errs, jsonschema.Error{Path: pathOf(it), Message: "is a number too large to hold"})
			}
		case map[string]any, []any:
			if it.depth > MaxDepth {
				errs = append(errs, jsonschema.Error{Path: pathOf(it), Message: fmt.Sprintf("nests more than %d deep", MaxDepth)})
				continue
			}
			if m, ok := x.(map[string]any); ok {
				for k, sub := range m {
					stack = append(stack, &item{sub, it, k, it.depth + 1})
				}
			} else {
				for i, sub := range x.([]any) {
					stack = append(stack, &item{sub, it, strconv.Itoa(i), it.depth + 1})
				}
			}
		}
	}
	sort.Slice(errs, func(i, j int) bool { return errs[i].Path < errs[j].Path })
	return errs
}

// own lists the properties that belong to one theme file and are never
// inherited from the theme it extends.
var own = []string{"$schema", "name", "description", "author", "extends"}

// ResolveBuiltin resolves the built-in theme called name; base, where every
// theme starts, is already complete.
func ResolveBuiltin(name string, builtins map[string]map[string]any) (map[string]any, error) {
	theme, ok := builtins[name]
	if !ok {
		return nil, fmt.Errorf("no built-in theme %q", name)
	}
	if name == "base" {
		return clone(theme).(map[string]any), nil
	}
	return Resolve(theme, builtins)
}

// Resolve returns theme merged onto the theme it extends, which is itself
// merged the same way, down to base: objects merge key by key, and any
// other value replaces the one beneath it. builtins holds the built-in
// themes as loaded, by name. The result shares nothing with them.
//
// A theme shown in one scheme only -- because it forces that scheme, or
// extends one that does -- keeps only that scheme's colours, and is
// refused if it sets the other's itself: they would never be shown.
// Dropping the other scheme happens once, on the finished result, so a
// theme that extends a forced one and sets scheme back to auto still has
// base's colours for the scheme its parent left out.
func Resolve(theme map[string]any, builtins map[string]map[string]any) (map[string]any, error) {
	out, err := chain(theme, builtins, 0)
	if err != nil {
		return nil, err
	}
	if schemes := Schemes(out); len(schemes) == 1 {
		shown := schemes[0]
		own, _ := theme["colors"].(map[string]any)
		for scheme := range own {
			if scheme != shown {
				return nil, jsonschema.Error{Path: "/colors/" + scheme, Message: fmt.Sprintf("this theme is shown only in %s, so its %s colours would never be used", shown, scheme)}
			}
		}
		if colors, ok := out["colors"].(map[string]any); ok {
			out["colors"] = map[string]any{shown: colors[shown]}
		}
	}
	return out, nil
}

// chain merges theme onto everything beneath it, with every scheme's
// colours still present.
func chain(theme map[string]any, builtins map[string]map[string]any, depth int) (map[string]any, error) {
	if depth > len(Builtins) {
		return nil, jsonschema.Error{Path: "/extends", Message: "themes extend each other in a cycle"}
	}
	parentName, _ := theme["extends"].(string)
	if parentName == "" {
		parentName = "base"
	}
	parent, ok := builtins[parentName]
	if !ok {
		return nil, jsonschema.Error{Path: "/extends", Message: fmt.Sprintf("%q is not a built-in theme", parentName)}
	}
	beneath := parent
	if parentName != "base" {
		var err error
		if beneath, err = chain(parent, builtins, depth+1); err != nil {
			return nil, err
		}
	}
	inherited := map[string]any{}
	for k, v := range beneath {
		if !slices.Contains(own, k) && !strings.HasPrefix(k, "x-") {
			inherited[k] = v
		}
	}
	return merge(inherited, theme), nil
}

// merge returns a new value: over merged onto under, sharing no map or
// slice with either.
func merge(under, over map[string]any) map[string]any {
	out := make(map[string]any, len(under)+len(over))
	for k, v := range under {
		out[k] = clone(v)
	}
	for k, v := range over {
		if a, ok := out[k].(map[string]any); ok {
			if b, ok := v.(map[string]any); ok {
				out[k] = merge(a, b)
				continue
			}
		}
		out[k] = clone(v)
	}
	return out
}

func clone(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = clone(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = clone(e)
		}
		return out
	}
	return v
}

// Schemes returns the colour schemes a resolved theme is shown in.
func Schemes(resolved map[string]any) []string {
	switch resolved["scheme"] {
	case "light":
		return []string{"light"}
	case "dark":
		return []string{"dark"}
	}
	return []string{"light", "dark"}
}

// A contrastRule is a pair of colour roles and the least contrast WCAG 2.2
// asks of them: 4.5:1 for text (1.4.3), 3:1 for controls and the focus
// ring (1.4.11).
type contrastRule struct {
	fg, bg string
	min    float64
}

var contrastRules = []contrastRule{
	{"text", "canvas", 4.5},
	{"text", "surface", 4.5},
	{"muted", "canvas", 4.5},
	{"muted", "surface", 4.5},
	{"accent", "canvas", 3},
	{"control", "canvas", 3},
	{"controlActive", "canvas", 3},
	{"labelText", "label", 4.5},
	{"labelMuted", "label", 4.5},
	{"edgePrint", "film", 4.5},
}

// opaque lists the roles other colours are measured against, which must be
// opaque for the measure to mean anything.
var opaque = []string{"canvas", "surface", "label", "film"}

// CheckContrast returns every pair of roles in a resolved theme that falls
// short of the contrast it needs, in each scheme the theme is shown in,
// each at the place of the colour that falls short (in the resolved theme:
// the theme itself may have set only the colour beneath it).
func CheckContrast(resolved map[string]any) []error {
	var errs []error
	colors, _ := resolved["colors"].(map[string]any)
	for _, scheme := range Schemes(resolved) {
		palette, _ := colors[scheme].(map[string]any)
		at := func(role string) string { return "/colors/" + scheme + "/" + role }
		// A role that is not set, or not a colour, is reported once,
		// however many pairs it is in.
		bad := map[string]bool{}
		get := func(role string) (RGBA, bool) {
			s, ok := palette[role].(string)
			var c RGBA
			var err error
			if !ok {
				err = errors.New("is not set")
			} else if c, err = ParseColor(s); err == nil {
				return c, true
			}
			if !bad[role] {
				bad[role] = true
				errs = append(errs, jsonschema.Error{Path: at(role), Message: err.Error()})
			}
			return RGBA{}, false
		}
		for _, role := range opaque {
			if c, ok := get(role); ok && c.A != 1 {
				errs = append(errs, jsonschema.Error{Path: at(role), Message: "must be opaque"})
			}
		}
		for _, r := range contrastRules {
			fg, ok1 := get(r.fg)
			bg, ok2 := get(r.bg)
			if !ok1 || !ok2 {
				continue
			}
			if c := Contrast(fg, bg); c < r.min {
				errs = append(errs, jsonschema.Error{Path: at(r.fg), Message: fmt.Sprintf("on %s is %.2f:1, needs %.1f:1", r.bg, c, r.min)})
			}
		}
	}
	return errs
}

// RGBA is a colour in sRGB, each channel from 0 to 1.
type RGBA struct{ R, G, B, A float64 }

var (
	hexColor = regexp.MustCompile(`^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)
	rgbColor = regexp.MustCompile(`^rgb\( ?([0-9]{1,3}) ([0-9]{1,3}) ([0-9]{1,3})(?: / ([0-9.]+%?))? ?\)$`)
)

// ParseColor reads the colour forms the theme schema allows.
func ParseColor(s string) (RGBA, error) {
	if m := hexColor.FindStringSubmatch(s); m != nil {
		h := m[1]
		if len(h) <= 4 { // #rgb(a): each digit doubled
			var b strings.Builder
			for _, c := range h {
				b.WriteRune(c)
				b.WriteRune(c)
			}
			h = b.String()
		}
		if len(h) == 6 {
			h += "ff"
		}
		v, _ := strconv.ParseUint(h, 16, 32)
		return RGBA{
			float64(v>>24&0xff) / 255, float64(v>>16&0xff) / 255,
			float64(v>>8&0xff) / 255, float64(v&0xff) / 255,
		}, nil
	}
	if m := rgbColor.FindStringSubmatch(s); m != nil {
		var ch [3]float64
		for i := range 3 {
			n, _ := strconv.Atoi(m[i+1])
			if n > 255 {
				return RGBA{}, fmt.Errorf("%q: a channel is more than 255", s)
			}
			ch[i] = float64(n) / 255
		}
		a := 1.0
		if m[4] != "" {
			pct := strings.HasSuffix(m[4], "%")
			f, err := strconv.ParseFloat(strings.TrimSuffix(m[4], "%"), 64)
			if err != nil {
				return RGBA{}, fmt.Errorf("%q: %w", s, err)
			}
			if pct {
				f /= 100
			}
			if f < 0 || f > 1 {
				return RGBA{}, fmt.Errorf("%q: alpha is outside 0 to 1", s)
			}
			a = f
		}
		return RGBA{ch[0], ch[1], ch[2], a}, nil
	}
	return RGBA{}, fmt.Errorf("%q is not a colour", s)
}

// Over composites c over an opaque background.
func (c RGBA) Over(bg RGBA) RGBA {
	mix := func(f, b float64) float64 { return f*c.A + b*(1-c.A) }
	return RGBA{mix(c.R, bg.R), mix(c.G, bg.G), mix(c.B, bg.B), 1}
}

// Luminance is the relative luminance WCAG defines, of an opaque colour.
func (c RGBA) Luminance() float64 {
	lin := func(v float64) float64 {
		if v <= 0.04045 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(c.R) + 0.7152*lin(c.G) + 0.0722*lin(c.B)
}

// Contrast is the WCAG contrast ratio of fg, composited over bg, against
// bg, which must be opaque.
func Contrast(fg, bg RGBA) float64 {
	a, b := fg.Over(bg).Luminance(), bg.Luminance()
	if a < b {
		a, b = b, a
	}
	return (a + 0.05) / (b + 0.05)
}

// thumbhashPattern is the schema's pattern for a placeholder's thumbhash,
// written out because CheckManifest is not given the schema
// (TestManifestLimits keeps the two the same). A thumbhash it refuses is
// the schema's to report; CheckManifest looks only at those it accepts.
var thumbhashPattern = regexp.MustCompile(`^[A-Za-z0-9+/]{6,64}={0,2}$`)

// CheckManifest returns what is wrong with a valid manifest that its schema
// cannot say: slide ids that repeat; sources of one slide that repeat a
// width and type, which leaves the browser two files to choose between;
// and a thumbhash that is not one -- not base64 as a browser reads it, or
// too short for what its header says -- which would quietly paint nothing.
func CheckManifest(doc map[string]any) []error {
	var errs []error
	slides, _ := doc["slides"].([]any)
	seen := map[string]int{}
	for i, s := range slides {
		slide, _ := s.(map[string]any)
		// An id that is not a string, or a width that is not a number, is
		// the schema's to report, and is skipped here -- as the browser
		// skips it (src/manifest.ts check), so both report the same places.
		if id, ok := slide["id"].(string); ok {
			if j, ok := seen[id]; ok {
				errs = append(errs, jsonschema.Error{Path: fmt.Sprintf("/slides/%d/id", i), Message: fmt.Sprintf("%q is also the id of slide %d", id, j)})
			} else {
				seen[id] = i
			}
		}
		sources, _ := slide["sources"].([]any)
		widths := map[string]bool{}
		for k, src := range sources {
			m, _ := src.(map[string]any)
			// Widths compare as numbers (640 and 640.0 are one width). A
			// source without a type is the fallback for browsers that take
			// none of the typed ones, so it may share a width with them.
			// Only what the schema accepts, as the browser does: a whole
			// width from 1 to 100,000, and a type absent or a string.
			w, ok := m["width"].(json.Number)
			if !ok {
				continue
			}
			width, err := w.Float64()
			if err != nil || width != math.Trunc(width) || width < 1 || width > 100000 {
				continue
			}
			typ, isString := m["type"].(string)
			if _, present := m["type"]; present && !isString {
				continue
			}
			key := fmt.Sprintf("%d %s", int(width), typ)
			if widths[key] {
				errs = append(errs, jsonschema.Error{Path: fmt.Sprintf("/slides/%d/sources/%d", i, k), Message: "another source has the same width and type"})
			}
			widths[key] = true
		}
		placeholder, _ := slide["placeholder"].(map[string]any)
		if text, ok := placeholder["thumbhash"].(string); ok && thumbhashPattern.MatchString(text) {
			if hash, err := thumbhash.FromBase64(text); err != nil || thumbhash.Check(hash) != nil {
				errs = append(errs, jsonschema.Error{Path: fmt.Sprintf("/slides/%d/placeholder/thumbhash", i), Message: "is not a ThumbHash"})
			}
		}
	}
	return errs
}
