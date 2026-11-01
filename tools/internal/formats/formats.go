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
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/wisborg/clack/tools/internal/jsonc"
	"github.com/wisborg/clack/tools/internal/jsonschema"
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

// Load reads a theme or manifest file -- comments allowed -- and validates
// it against schema, returning the document and every way it fails.
func Load(schema *jsonschema.Schema, path string) (map[string]any, []error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, []error{err}
	}
	return Parse(schema, data)
}

// Parse is Load for a document already in memory.
func Parse(schema *jsonschema.Schema, data []byte) (map[string]any, []error) {
	stripped, err := jsonc.Strip(data)
	if err != nil {
		return nil, []error{err}
	}
	v, err := jsonschema.Decode(stripped)
	if err != nil {
		return nil, []error{err}
	}
	var errs []error
	for _, e := range schema.Validate(v) {
		errs = append(errs, e)
	}
	doc, _ := v.(map[string]any)
	return doc, errs
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
		return theme, nil
	}
	return Resolve(theme, builtins)
}

// Resolve returns theme merged onto the theme it extends, which is itself
// resolved the same way, down to base: objects merge key by key, and any
// other value replaces the one beneath it. builtins holds the built-in
// themes as loaded, by name.
func Resolve(theme map[string]any, builtins map[string]map[string]any) (map[string]any, error) {
	return resolve(theme, builtins, 0)
}

func resolve(theme map[string]any, builtins map[string]map[string]any, depth int) (map[string]any, error) {
	if depth > len(Builtins) {
		return nil, errors.New("themes extend each other in a cycle")
	}
	parentName, _ := theme["extends"].(string)
	if parentName == "" {
		parentName = "base"
	}
	parent, ok := builtins[parentName]
	if !ok {
		return nil, fmt.Errorf("extends %q, which is not a built-in theme", parentName)
	}
	resolvedParent := parent
	if parentName != "base" {
		var err error
		if resolvedParent, err = resolve(parent, builtins, depth+1); err != nil {
			return nil, err
		}
	}
	inherited := map[string]any{}
	for k, v := range resolvedParent {
		if !slices.Contains(own, k) && !strings.HasPrefix(k, "x-") {
			inherited[k] = v
		}
	}
	out := merge(inherited, theme)
	// A theme that forces a scheme is shown only in that one, so the other
	// scheme's colours, inherited from a theme that follows the visitor,
	// would be dead weight -- and a forced theme may not carry them.
	if schemes := Schemes(out); len(schemes) == 1 {
		if colors, ok := out["colors"].(map[string]any); ok {
			out["colors"] = map[string]any{schemes[0]: colors[schemes[0]]}
		}
	}
	return out, nil
}

func merge(under, over map[string]any) map[string]any {
	out := make(map[string]any, len(under)+len(over))
	for k, v := range under {
		out[k] = v
	}
	for k, v := range over {
		if a, ok := out[k].(map[string]any); ok {
			if b, ok := v.(map[string]any); ok {
				out[k] = merge(a, b)
				continue
			}
		}
		out[k] = v
	}
	return out
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
// short of the contrast it needs, in each scheme the theme is shown in.
func CheckContrast(resolved map[string]any) []error {
	var errs []error
	colors, _ := resolved["colors"].(map[string]any)
	for _, scheme := range Schemes(resolved) {
		palette, _ := colors[scheme].(map[string]any)
		get := func(role string) (RGBA, error) {
			s, ok := palette[role].(string)
			if !ok {
				return RGBA{}, fmt.Errorf("%s: %s is not set", scheme, role)
			}
			c, err := ParseColor(s)
			if err != nil {
				return RGBA{}, fmt.Errorf("%s: %s: %w", scheme, role, err)
			}
			return c, nil
		}
		for _, role := range opaque {
			c, err := get(role)
			if err != nil {
				errs = append(errs, err)
			} else if c.A != 1 {
				errs = append(errs, fmt.Errorf("%s: %s must be opaque", scheme, role))
			}
		}
		for _, r := range contrastRules {
			fg, err1 := get(r.fg)
			bg, err2 := get(r.bg)
			if err := errors.Join(err1, err2); err != nil {
				errs = append(errs, err)
				continue
			}
			if c := Contrast(fg, bg); c < r.min {
				errs = append(errs, fmt.Errorf("%s: %s on %s is %.2f:1, needs %.1f:1", scheme, r.fg, r.bg, c, r.min))
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

// CheckManifest returns what is wrong with a valid manifest that its schema
// cannot say: slide ids that repeat, and sources of one slide that repeat a
// width and type, which leaves the browser two files to choose between.
func CheckManifest(doc map[string]any) []error {
	var errs []error
	slides, _ := doc["slides"].([]any)
	seen := map[string]int{}
	for i, s := range slides {
		slide, _ := s.(map[string]any)
		id, _ := slide["id"].(string)
		if j, ok := seen[id]; ok {
			errs = append(errs, fmt.Errorf("/slides/%d/id: %q is also the id of slide %d", i, id, j))
		} else {
			seen[id] = i
		}
		sources, _ := slide["sources"].([]any)
		widths := map[string]bool{}
		for k, src := range sources {
			m, _ := src.(map[string]any)
			key := fmt.Sprint(m["width"], " ", m["type"])
			if widths[key] {
				errs = append(errs, fmt.Errorf("/slides/%d/sources/%d: another source has the same width and type", i, k))
			}
			widths[key] = true
		}
	}
	return errs
}
