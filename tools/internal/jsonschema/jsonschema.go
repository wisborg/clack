// Package jsonschema validates JSON documents against the part of JSON Schema
// (draft 2020-12) that Clack's own schemas use, and nothing more.
//
// It exists so the tools can check the built-in themes and the example
// manifests against the published schemas without a dependency. Compile
// refuses any keyword outside the subset, so a schema can never rely on a
// rule this package would silently skip: adding a keyword to a schema means
// adding it here, with a test.
//
// The subset: type, const, enum; properties, patternProperties,
// additionalProperties, required, dependentRequired, propertyNames,
// minProperties, maxProperties; items, minItems, maxItems; minLength, maxLength, pattern;
// minimum, maximum, exclusiveMinimum, exclusiveMaximum; allOf, anyOf, oneOf,
// not, if/then/else; $ref to the schema's own $defs. Annotations ($schema,
// $id, $comment, title, description, default, examples, markdownDescription)
// are accepted and ignored. Patterns are RE2 (Go's regexp); the schemas keep
// to the syntax RE2 and ECMAScript share, so browsers and editors read them
// the same way.
package jsonschema

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// A Schema is a compiled schema, ready to validate documents.
type Schema struct {
	root *node
}

// An Error is one way a document fails its schema.
type Error struct {
	Path    string // a JSON Pointer to the value, "" for the document itself
	Message string
}

func (e Error) Error() string {
	if e.Path == "" {
		return "(document): " + e.Message
	}
	return e.Path + ": " + e.Message
}

// node is one compiled (sub)schema. A boolean schema is a node with only
// always set: true accepts everything, false nothing.
type node struct {
	always *bool

	types    []string
	constVal any
	hasConst bool
	enum     []any

	properties         map[string]*node
	patternProperties  []patternNode
	additional         *node
	required           []string
	dependentRequired  map[string][]string
	propertyNames      *node
	minProps, maxProps *int

	items              *node
	minItems, maxItems *int

	minLength, maxLength *int
	pattern              *regexp.Regexp
	patternSrc           string

	minimum, maximum                   *float64
	exclusiveMinimum, exclusiveMaximum *float64

	allOf, anyOf, oneOf        []*node
	not                        *node
	ifNode, thenNode, elseNode *node

	ref     string
	refNode *node
}

type patternNode struct {
	re  *regexp.Regexp
	src string
	n   *node
}

var annotations = map[string]bool{
	"$schema": true, "$id": true, "$comment": true, "title": true, "description": true,
	"default": true, "examples": true, "markdownDescription": true,
}

var knownTypes = map[string]bool{
	"null": true, "boolean": true, "object": true, "array": true,
	"number": true, "integer": true, "string": true,
}

// Compile parses a schema, refusing any keyword outside the subset, any
// $ref that does not name one of its own $defs, and any pattern Go cannot
// compile.
func Compile(data []byte) (*Schema, error) {
	v, err := Decode(data)
	if err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	root, ok := v.(map[string]any)
	if !ok {
		return nil, errors.New("schema: the root must be an object")
	}
	c := &compiler{defs: map[string]*node{}}
	if raw, ok := root["$defs"]; ok {
		defs, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("schema: $defs must be an object")
		}
		// Every definition gets its node first, so refs between them (and
		// to themselves) resolve whatever order they are written in.
		for name := range defs {
			c.defs[name] = &node{}
		}
		for _, name := range sortedKeys(defs) {
			if err := c.fill(c.defs[name], defs[name], "/$defs/"+name); err != nil {
				return nil, err
			}
		}
	}
	n := &node{}
	if err := c.fill(n, root, ""); err != nil {
		return nil, err
	}
	return &Schema{root: n}, nil
}

type compiler struct {
	defs map[string]*node
}

func (c *compiler) compile(v any, at string) (*node, error) {
	n := &node{}
	return n, c.fill(n, v, at)
}

func (c *compiler) fill(n *node, v any, at string) error {
	fail := func(format string, args ...any) error {
		return fmt.Errorf("schema %s: %s", orRoot(at), fmt.Sprintf(format, args...))
	}
	if b, ok := v.(bool); ok {
		n.always = &b
		return nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return fail("a schema must be an object or a boolean")
	}
	for _, key := range sortedKeys(m) {
		val := m[key]
		sub := at + "/" + key
		var err error
		switch key {
		case "$defs":
			if at != "" {
				return fail("$defs is only allowed at the root")
			}
		case "type":
			switch t := val.(type) {
			case string:
				n.types = []string{t}
			case []any:
				for _, x := range t {
					s, ok := x.(string)
					if !ok {
						return fail("type must be a string or an array of strings")
					}
					n.types = append(n.types, s)
				}
			default:
				return fail("type must be a string or an array of strings")
			}
			for _, t := range n.types {
				if !knownTypes[t] {
					return fail("unknown type %q", t)
				}
			}
		case "const":
			n.constVal, n.hasConst = val, true
		case "enum":
			list, ok := val.([]any)
			if !ok || len(list) == 0 {
				return fail("enum must be a non-empty array")
			}
			n.enum = list
		case "properties":
			props, ok := val.(map[string]any)
			if !ok {
				return fail("properties must be an object")
			}
			n.properties = map[string]*node{}
			for _, name := range sortedKeys(props) {
				if n.properties[name], err = c.compile(props[name], sub+"/"+name); err != nil {
					return err
				}
			}
		case "patternProperties":
			props, ok := val.(map[string]any)
			if !ok {
				return fail("patternProperties must be an object")
			}
			for _, src := range sortedKeys(props) {
				re, err := regexp.Compile(src)
				if err != nil {
					return fail("pattern %q: %v", src, err)
				}
				pn, err := c.compile(props[src], sub+"/"+src)
				if err != nil {
					return err
				}
				n.patternProperties = append(n.patternProperties, patternNode{re, src, pn})
			}
		case "additionalProperties":
			n.additional, err = c.compile(val, sub)
		case "propertyNames":
			n.propertyNames, err = c.compile(val, sub)
		case "items":
			n.items, err = c.compile(val, sub)
		case "not":
			n.not, err = c.compile(val, sub)
		case "if":
			n.ifNode, err = c.compile(val, sub)
		case "then":
			n.thenNode, err = c.compile(val, sub)
		case "else":
			n.elseNode, err = c.compile(val, sub)
		case "required":
			list, ok := val.([]any)
			if !ok {
				return fail("required must be an array of strings")
			}
			for _, x := range list {
				s, ok := x.(string)
				if !ok {
					return fail("required must be an array of strings")
				}
				n.required = append(n.required, s)
			}
		case "dependentRequired":
			deps, ok := val.(map[string]any)
			if !ok {
				return fail("dependentRequired must be an object of arrays of strings")
			}
			n.dependentRequired = map[string][]string{}
			for _, name := range sortedKeys(deps) {
				list, ok := deps[name].([]any)
				if !ok {
					return fail("dependentRequired must be an object of arrays of strings")
				}
				for _, x := range list {
					s, ok := x.(string)
					if !ok {
						return fail("dependentRequired must be an object of arrays of strings")
					}
					n.dependentRequired[name] = append(n.dependentRequired[name], s)
				}
			}
		case "minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength":
			i, ok := asCount(val)
			if !ok {
				return fail("%s must be a non-negative integer", key)
			}
			switch key {
			case "minProperties":
				n.minProps = &i
			case "maxProperties":
				n.maxProps = &i
			case "minItems":
				n.minItems = &i
			case "maxItems":
				n.maxItems = &i
			case "minLength":
				n.minLength = &i
			default:
				n.maxLength = &i
			}
		case "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum":
			f, ok := asNumber(val)
			if !ok {
				return fail("%s must be a number", key)
			}
			switch key {
			case "minimum":
				n.minimum = &f
			case "maximum":
				n.maximum = &f
			case "exclusiveMinimum":
				n.exclusiveMinimum = &f
			default:
				n.exclusiveMaximum = &f
			}
		case "pattern":
			s, ok := val.(string)
			if !ok {
				return fail("pattern must be a string")
			}
			if n.pattern, err = regexp.Compile(s); err != nil {
				return fail("pattern %q: %v", s, err)
			}
			n.patternSrc = s
		case "allOf", "anyOf", "oneOf":
			list, ok := val.([]any)
			if !ok || len(list) == 0 {
				return fail("%s must be a non-empty array of schemas", key)
			}
			var nodes []*node
			for i, x := range list {
				sn, err := c.compile(x, sub+"/"+strconv.Itoa(i))
				if err != nil {
					return err
				}
				nodes = append(nodes, sn)
			}
			switch key {
			case "allOf":
				n.allOf = nodes
			case "anyOf":
				n.anyOf = nodes
			default:
				n.oneOf = nodes
			}
		case "$ref":
			s, ok := val.(string)
			name, local := strings.CutPrefix(s, "#/$defs/")
			if !ok || !local {
				return fail("$ref must name one of this schema's $defs (#/$defs/<name>), not %v", val)
			}
			target, ok := c.defs[name]
			if !ok {
				return fail("$ref %q: no such definition", s)
			}
			n.ref, n.refNode = s, target
		default:
			if !annotations[key] {
				return fail("keyword %q is not in the subset this validator implements", key)
			}
		}
		if err != nil {
			return err
		}
	}
	if (n.thenNode != nil || n.elseNode != nil) && n.ifNode == nil {
		return fail("then or else without if")
	}
	return nil
}

// Validate returns every way doc fails the schema, sorted by path; none
// means it is valid. doc must come from Decode, so numbers are json.Number.
func (s *Schema) Validate(doc any) []Error {
	var errs []Error
	s.root.validate(doc, "", &errs)
	sort.SliceStable(errs, func(i, j int) bool { return errs[i].Path < errs[j].Path })
	return errs
}

func (n *node) validate(v any, path string, errs *[]Error) {
	add := func(format string, args ...any) {
		*errs = append(*errs, Error{path, fmt.Sprintf(format, args...)})
	}
	if n.always != nil {
		if !*n.always {
			add("is not allowed here")
		}
		return
	}
	if n.refNode != nil {
		n.refNode.validate(v, path, errs)
	}
	if len(n.types) > 0 && !slices.ContainsFunc(n.types, func(t string) bool { return isType(v, t) }) {
		add("must be %s, not %s", strings.Join(n.types, " or "), typeOf(v))
		return // the keywords below assume the type
	}
	if n.hasConst && !equal(v, n.constVal) {
		add("must be %s", show(n.constVal))
	}
	if n.enum != nil && !slices.ContainsFunc(n.enum, func(e any) bool { return equal(v, e) }) {
		var shown []string
		for _, e := range n.enum {
			shown = append(shown, show(e))
		}
		add("must be one of %s, not %s", strings.Join(shown, ", "), show(v))
	}

	switch x := v.(type) {
	case map[string]any:
		n.validateObject(x, path, errs)
	case []any:
		if n.minItems != nil && len(x) < *n.minItems {
			add("must have at least %d items", *n.minItems)
		}
		if n.maxItems != nil && len(x) > *n.maxItems {
			add("must have at most %d items", *n.maxItems)
		}
		if n.items != nil {
			for i, item := range x {
				n.items.validate(item, path+"/"+strconv.Itoa(i), errs)
			}
		}
	case string:
		length := utf8.RuneCountInString(x)
		if n.minLength != nil && length < *n.minLength {
			add("must be at least %d characters", *n.minLength)
		}
		if n.maxLength != nil && length > *n.maxLength {
			add("must be at most %d characters", *n.maxLength)
		}
		if n.pattern != nil && !n.pattern.MatchString(x) {
			add("%s does not have the expected form", show(x))
		}
	case json.Number:
		f, _ := x.Float64()
		if n.minimum != nil && f < *n.minimum {
			add("must be at least %v", *n.minimum)
		}
		if n.maximum != nil && f > *n.maximum {
			add("must be at most %v", *n.maximum)
		}
		if n.exclusiveMinimum != nil && f <= *n.exclusiveMinimum {
			add("must be more than %v", *n.exclusiveMinimum)
		}
		if n.exclusiveMaximum != nil && f >= *n.exclusiveMaximum {
			add("must be less than %v", *n.exclusiveMaximum)
		}
	}

	for _, sub := range n.allOf {
		sub.validate(v, path, errs)
	}
	if n.anyOf != nil {
		if matches, failures := tryEach(n.anyOf, v, path); matches == 0 {
			*errs = append(*errs, closest(failures, path)...)
		}
	}
	if n.oneOf != nil {
		switch matches, failures := tryEach(n.oneOf, v, path); {
		case matches == 0:
			*errs = append(*errs, closest(failures, path)...)
		case matches > 1:
			add("matches more than one of the allowed forms")
		}
	}
	if n.not != nil && len(n.not.check(v, path)) == 0 {
		add("has a form that is not allowed here")
	}
	if n.ifNode != nil {
		if len(n.ifNode.check(v, path)) == 0 {
			if n.thenNode != nil {
				n.thenNode.validate(v, path, errs)
			}
		} else if n.elseNode != nil {
			n.elseNode.validate(v, path, errs)
		}
	}
}

// tryEach validates v against each alternative, counting those it matches
// and keeping the errors of those it does not.
func tryEach(alternatives []*node, v any, path string) (matches int, failures [][]Error) {
	for _, sub := range alternatives {
		if e := sub.check(v, path); len(e) == 0 {
			matches++
		} else {
			failures = append(failures, e)
		}
	}
	return matches, failures
}

// closest reports why the nearest of several failed alternatives failed.
// One that failed only inside the value (the right type, a wrong property)
// is nearer than one that failed on the value itself, and among those the
// one with fewest errors is nearest; its errors are the useful ones. When
// every alternative failed on the value itself, any one message would
// mislead -- the value may have been meant as another form -- so a summary
// is given instead.
func closest(failures [][]Error, path string) []Error {
	atValue := func(errs []Error) bool {
		return slices.ContainsFunc(errs, func(e Error) bool { return e.Path == path })
	}
	var best []Error
	for _, e := range failures {
		if !atValue(e) && (best == nil || len(e) < len(best)) {
			best = e
		}
	}
	if best == nil {
		return []Error{{path, "matches none of the allowed forms"}}
	}
	return best
}

func (n *node) validateObject(x map[string]any, path string, errs *[]Error) {
	add := func(format string, args ...any) {
		*errs = append(*errs, Error{path, fmt.Sprintf(format, args...)})
	}
	for _, r := range n.required {
		if _, ok := x[r]; !ok {
			add("%s is required", show(r))
		}
	}
	for _, name := range sortedKeys(x) {
		for _, r := range n.dependentRequired[name] {
			if _, ok := x[r]; !ok {
				add("%s is required with %s", show(r), show(name))
			}
		}
	}
	if n.minProps != nil && len(x) < *n.minProps {
		add("must have at least %d properties", *n.minProps)
	}
	if n.maxProps != nil && len(x) > *n.maxProps {
		add("must have at most %d properties", *n.maxProps)
	}
	for _, key := range sortedKeys(x) {
		child := path + "/" + escapePointer(key)
		if n.propertyNames != nil {
			for _, e := range n.propertyNames.check(key, child) {
				*errs = append(*errs, Error{child, "property name " + e.Message})
			}
		}
		matched := false
		if p, ok := n.properties[key]; ok {
			p.validate(x[key], child, errs)
			matched = true
		}
		for _, pp := range n.patternProperties {
			if pp.re.MatchString(key) {
				pp.n.validate(x[key], child, errs)
				matched = true
			}
		}
		if !matched && n.additional != nil {
			if n.additional.always != nil && !*n.additional.always {
				*errs = append(*errs, Error{child, "is not a property this object has"})
			} else {
				n.additional.validate(x[key], child, errs)
			}
		}
	}
}

func (n *node) check(v any, path string) []Error {
	var errs []Error
	n.validate(v, path, &errs)
	return errs
}

// Decode parses JSON the way Validate expects it: numbers kept as
// json.Number, so integers can be told apart, and nothing after the value.
func Decode(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("something follows the JSON value")
	}
	return v, nil
}

func isType(v any, t string) bool {
	switch t {
	case "null":
		return v == nil
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "object":
		_, ok := v.(map[string]any)
		return ok
	case "array":
		_, ok := v.([]any)
		return ok
	case "string":
		_, ok := v.(string)
		return ok
	case "number":
		_, ok := v.(json.Number)
		return ok
	case "integer":
		num, ok := v.(json.Number)
		if !ok {
			return false
		}
		f, err := num.Float64()
		return err == nil && f == math.Trunc(f) && !math.IsInf(f, 0)
	}
	return false
}

func typeOf(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "a boolean"
	case map[string]any:
		return "an object"
	case []any:
		return "an array"
	case string:
		return "a string"
	case json.Number:
		return "a number"
	}
	return fmt.Sprintf("%T", v)
}

// equal compares two decoded JSON values; numbers compare by value, so 1
// and 1.0 are equal, as JSON Schema requires.
func equal(a, b any) bool {
	switch x := a.(type) {
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		fx, ex := x.Float64()
		fy, ey := y.Float64()
		return ex == nil && ey == nil && fx == fy
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, xv := range x {
			yv, ok := y[k]
			if !ok || !equal(xv, yv) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !equal(x[i], y[i]) {
				return false
			}
		}
		return true
	default:
		return a == b
	}
}

func show(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	if len(b) > 60 {
		return string(b[:57]) + "..."
	}
	return string(b)
}

func asCount(v any) (int, bool) {
	num, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := num.Int64()
	return int(i), err == nil && i >= 0 && i <= math.MaxInt32
}

func asNumber(v any) (float64, bool) {
	num, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := num.Float64()
	return f, err == nil
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func escapePointer(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}

func orRoot(at string) string {
	if at == "" {
		return "(root)"
	}
	return at
}
