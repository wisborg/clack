package jsonschema

import (
	"strings"
	"testing"
)

func mustCompile(t *testing.T, schema string) *Schema {
	t.Helper()
	s, err := Compile([]byte(schema))
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	return s
}

func validate(t *testing.T, s *Schema, doc string) []Error {
	t.Helper()
	v, err := Decode([]byte(doc))
	if err != nil {
		t.Fatalf("decode %s: %v", doc, err)
	}
	return s.Validate(v)
}

// check runs each document against the schema: a want of "" means valid;
// otherwise the errors, joined, must contain want.
func check(t *testing.T, schema string, cases map[string]string) {
	t.Helper()
	s := mustCompile(t, schema)
	for doc, want := range cases {
		errs := validate(t, s, doc)
		var msgs []string
		for _, e := range errs {
			msgs = append(msgs, e.Error())
		}
		got := strings.Join(msgs, "; ")
		switch {
		case want == "" && len(errs) > 0:
			t.Errorf("%s: want valid, got %s", doc, got)
		case want != "" && !strings.Contains(got, want):
			t.Errorf("%s: want an error containing %q, got %q", doc, want, got)
		}
	}
}

func TestCompileRefusesWhatItDoesNotImplement(t *testing.T) {
	for name, schema := range map[string]string{
		"an unknown keyword":    `{"type": "string", "format": "email"}`,
		"a misspelt keyword":    `{"properties": {"a": {"maxLenght": 3}}}`,
		"a remote ref":          `{"$ref": "https://example.com/s.json"}`,
		"a ref to nowhere":      `{"$ref": "#/$defs/missing"}`,
		"a non-local pointer":   `{"$ref": "#/properties/a"}`,
		"a bad pattern":         `{"pattern": "(?=x)"}`,
		"an unknown type":       `{"type": "float"}`,
		"then without if":       `{"then": {}}`,
		"nested $defs":          `{"properties": {"a": {"$defs": {}}}}`,
		"a negative bound":      `{"minLength": -1}`,
		"an empty enum":         `{"enum": []}`,
		"not a schema":          `{"properties": {"a": 3}}`,
		"a non-object root":     `true`,
		"trailing data":         `{} {}`,
		"bad dependentRequired": `{"dependentRequired": {"a": "b"}}`,
	} {
		if _, err := Compile([]byte(schema)); err == nil {
			t.Errorf("%s: compiled, want a refusal", name)
		}
	}
}

func TestAnnotationsAreAccepted(t *testing.T) {
	mustCompile(t, `{"$schema": "x", "$id": "y", "$comment": "z", "title": "t",
		"description": "d", "default": 1, "examples": [1], "markdownDescription": "m"}`)
}

func TestTypes(t *testing.T) {
	check(t, `{"type": "integer"}`, map[string]string{
		`3`:     "",
		`3.0`:   "", // JSON Schema counts 3.0 as an integer
		`3.5`:   "must be integer, not a number",
		`"3"`:   "must be integer, not a string",
		`1e400`: "must be integer",
	})
	check(t, `{"type": ["string", "null"]}`, map[string]string{
		`"a"`:  "",
		`null`: "",
		`true`: "must be string or null, not a boolean",
	})
}

func TestConstAndEnum(t *testing.T) {
	check(t, `{"const": "clack-theme/1"}`, map[string]string{
		`"clack-theme/1"`: "",
		`"clack-theme/2"`: `must be "clack-theme/1"`,
	})
	check(t, `{"enum": [300, 400, "a", {"b": [1]}]}`, map[string]string{
		`400`:       "",
		`400.0`:     "", // numbers compare by value
		`"a"`:       "",
		`{"b":[1]}`: "",
		`{"b":[2]}`: "must be one of",
		`500`:       "must be one of 300, 400",
	})
}

func TestObjects(t *testing.T) {
	schema := `{
		"type": "object",
		"required": ["name"],
		"properties": {"name": {"type": "string"}, "size": {"type": "integer"}},
		"patternProperties": {"^x-": true},
		"additionalProperties": false,
		"dependentRequired": {"latitude": ["longitude"]},
		"maxProperties": 4
	}`
	check(t, schema, map[string]string{
		`{"name": "a"}`:                                "",
		`{"name": "a", "x-note": [1, 2]}`:              "",
		`{}`:                                           `(document): "name" is required`,
		`{"name": "a", "colour": "red"}`:               "/colour: is not a property this object has",
		`{"name": 1}`:                                  "/name: must be string",
		`{"name": "a", "size": "big"}`:                 "/size: must be integer",
		`{"name": "a", "latitude": 1}`:                 `"longitude" is required with "latitude"`,
		`{"name":"a","x-1":0,"x-2":0,"x-3":0,"x-4":0}`: "at most 4 properties",
	})
	// Property names with a / or ~ are escaped in the error's pointer.
	check(t, `{"additionalProperties": false}`, map[string]string{
		`{"a/b~c": 1}`: "/a~1b~0c: is not a property",
	})
	check(t, `{"additionalProperties": {"type": "number"}}`, map[string]string{
		`{"a": 1}`:   "",
		`{"a": "1"}`: "/a: must be number",
	})
	check(t, `{"propertyNames": {"pattern": "^[a-z]+$"}}`, map[string]string{
		`{"ab": 1}`: "",
		`{"aB": 1}`: `/aB: property name "aB" does not have the expected form`,
	})
}

func TestArrays(t *testing.T) {
	check(t, `{"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 2}`, map[string]string{
		`["a"]`:           "",
		`[]`:              "at least 1 items",
		`["a", "b", "c"]`: "at most 2 items",
		`["a", 2]`:        "/1: must be string",
	})
}

func TestStrings(t *testing.T) {
	check(t, `{"type": "string", "minLength": 2, "maxLength": 3, "pattern": "^[a-zé]+$"}`, map[string]string{
		`"ab"`:   "",
		`"éée"`:  "", // lengths count characters, not bytes
		`"a"`:    "at least 2 characters",
		`"abcd"`: "at most 3 characters",
		`"AB"`:   `"AB" does not have the expected form`,
	})
}

func TestNumbers(t *testing.T) {
	check(t, `{"minimum": 0, "maximum": 1}`, map[string]string{
		`0`:    "",
		`1`:    "",
		`-0.1`: "at least 0",
		`1.5`:  "at most 1",
		`"2"`:  "", // bounds apply to numbers only
	})
	check(t, `{"exclusiveMinimum": 0, "exclusiveMaximum": 360}`, map[string]string{
		`0.001`: "",
		`0`:     "more than 0",
		`360`:   "less than 360",
	})
}

func TestCombinators(t *testing.T) {
	check(t, `{"allOf": [{"minLength": 2}, {"maxLength": 3}]}`, map[string]string{
		`"ab"`:   "",
		`"a"`:    "at least 2",
		`"abcd"`: "at most 3",
	})
	check(t, `{"anyOf": [{"type": "string"}, {"type": "integer"}]}`, map[string]string{
		`"a"`:  "",
		`1`:    "",
		`true`: "matches none of the allowed forms",
	})
	check(t, `{"oneOf": [{"type": "integer"}, {"type": "number"}]}`, map[string]string{
		`1.5`: "",
		`1`:   "matches more than one",
		`"a"`: "matches none of the allowed forms",
	})
	check(t, `{"not": {"required": ["light"]}}`, map[string]string{
		`{"dark": 1}`:  "",
		`{"light": 1}`: "not allowed here",
	})
	// When the closest alternative failed deeper in the value, its errors
	// are the useful ones.
	check(t, `{"oneOf": [{"type": "string"}, {"type": "object", "properties": {"min": {"type": "string"}}}]}`, map[string]string{
		`{"min": 1}`: "/min: must be string",
	})
}

func TestIfThenElse(t *testing.T) {
	schema := `{
		"if": {"required": ["scheme"], "properties": {"scheme": {"const": "dark"}}},
		"then": {"properties": {"colors": {"not": {"required": ["light"]}}}},
		"else": {"required": ["colors"]}
	}`
	check(t, schema, map[string]string{
		`{"scheme": "dark", "colors": {"dark": {}}}`:  "",
		`{"scheme": "dark", "colors": {"light": {}}}`: "/colors: has a form that is not allowed here",
		`{"scheme": "auto", "colors": {"light": {}}}`: "",
		`{"scheme": "auto"}`:                          `"colors" is required`,
	})
}

func TestRefs(t *testing.T) {
	schema := `{
		"$defs": {
			"tree": {"type": "object", "properties": {"kids": {"type": "array", "items": {"$ref": "#/$defs/tree"}}, "name": {"$ref": "#/$defs/name"}}},
			"name": {"type": "string", "maxLength": 3}
		},
		"$ref": "#/$defs/tree"
	}`
	check(t, schema, map[string]string{
		`{"name": "a", "kids": [{"name": "b", "kids": []}]}`: "",
		`{"kids": [{"kids": [{"name": "long"}]}]}`:           "/kids/0/kids/0/name: must be at most 3",
	})
	// A $ref's siblings apply too, as in draft 2020-12.
	check(t, `{"$defs": {"s": {"type": "string"}}, "$ref": "#/$defs/s", "maxLength": 1}`, map[string]string{
		`"a"`:  "",
		`"ab"`: "at most 1",
		`2`:    "must be string",
	})
}

func TestBooleanSchemas(t *testing.T) {
	check(t, `{"properties": {"a": true, "b": false}}`, map[string]string{
		`{"a": [1, {}]}`: "",
		`{"b": 1}`:       "/b: is not allowed here",
	})
}

func TestErrorsAreSortedByPath(t *testing.T) {
	s := mustCompile(t, `{"properties": {"a": {"type": "string"}, "b": {"type": "string"}}}`)
	errs := validate(t, s, `{"b": 1, "a": 1}`)
	if len(errs) != 2 || errs[0].Path != "/a" || errs[1].Path != "/b" {
		t.Errorf("got %v", errs)
	}
}

func TestDecode(t *testing.T) {
	for _, bad := range []string{`{} {}`, `{} x`, `{`, ``} {
		if _, err := Decode([]byte(bad)); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
	if _, err := Decode([]byte(" {}\n ")); err != nil {
		t.Errorf("surrounding space: %v", err)
	}
}

// A loop of definitions that never steps into the value would recurse
// forever; Compile refuses it. Recursion through a property is fine.
func TestCompileRefusesRefLoops(t *testing.T) {
	for name, schema := range map[string]string{
		"a ref to itself":        `{"$defs": {"a": {"$ref": "#/$defs/a"}}, "$ref": "#/$defs/a"}`,
		"two refs to each other": `{"$defs": {"a": {"$ref": "#/$defs/b"}, "b": {"$ref": "#/$defs/a"}}}`,
		"through allOf":          `{"$defs": {"a": {"allOf": [{"$ref": "#/$defs/a"}]}}}`,
		"through not":            `{"$defs": {"a": {"not": {"anyOf": [{"$ref": "#/$defs/a"}]}}}}`,
		"through if":             `{"$defs": {"a": {"if": {"$ref": "#/$defs/a"}}}}`,
	} {
		if _, err := Compile([]byte(schema)); err == nil || !strings.Contains(err.Error(), "loop") {
			t.Errorf("%s: err = %v, want a refusal for the loop", name, err)
		}
	}
	mustCompile(t, `{"$defs": {"tree": {"properties": {"kid": {"$ref": "#/$defs/tree"}}, "items": {"$ref": "#/$defs/tree"}}}}`)
}

// Recursion through a property is not a loop, even when the property is
// reached through allOf, which applies to the same value.
func TestRecursionInsideAllOfIsNotALoop(t *testing.T) {
	s := mustCompile(t, `{"$defs": {"a": {"allOf": [{"properties": {"x": {"$ref": "#/$defs/a"}}}]}}, "$ref": "#/$defs/a"}`)
	if errs := validate(t, s, `{"x": {"x": {}}}`); len(errs) > 0 {
		t.Error(errs)
	}
}

func TestStripAnnotations(t *testing.T) {
	schema := `{
		"$schema": "x", "title": "T", "description": "D",
		"type": "object",
		"properties": {
			"description": {"type": "string", "description": "a property called description"},
			"title": {"$ref": "#/$defs/t", "examples": ["a"]}
		},
		"$defs": {"t": {"type": "string", "maxLength": 3, "$comment": "c"}},
		"oneOf": [{"required": ["title"], "markdownDescription": "m"}, {"required": ["description"]}]
	}`
	out, err := StripAnnotations([]byte(schema))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"$defs":{"t":{"maxLength":3,"type":"string"}},"oneOf":[{"required":["title"]},{"required":["description"]}],"properties":{"description":{"type":"string"},"title":{"$ref":"#/$defs/t"}},"type":"object"}`
	if string(out) != want {
		t.Errorf("got  %s\nwant %s", out, want)
	}
	// The same rules: what one accepts and refuses, so does the other.
	a := mustCompile(t, schema)
	b := mustCompile(t, string(out))
	for _, doc := range []string{`{"title":"abc"}`, `{"title":"abcd"}`, `{"description":"x"}`, `{}`, `{"title":"a","description":"b"}`} {
		if (len(validate(t, a, doc)) == 0) != (len(validate(t, b, doc)) == 0) {
			t.Errorf("%s: the stripped schema decides otherwise", doc)
		}
	}
	if _, err := StripAnnotations([]byte(`{"format": "email"}`)); err == nil {
		t.Error("stripped a schema the validator refuses")
	}
}
