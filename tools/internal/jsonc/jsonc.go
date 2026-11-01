// Package jsonc removes comments from JSON, so hand-written theme files can
// be annotated. It is the reference for what Clack's loader in the browser
// accepts: // line comments and /* block */ comments outside strings, and
// nothing else -- no trailing commas, no single quotes, no unquoted keys.
package jsonc

import "errors"

// Strip returns data with every comment replaced by spaces, keeping each
// newline, so a parse error afterwards points at the same line and column
// as in the file. A comment that is never closed, or a string that is never
// closed, is an error rather than something to guess about.
func Strip(data []byte) ([]byte, error) {
	out := make([]byte, len(data))
	copy(out, data)
	blank := func(i int) {
		if out[i] != '\n' && out[i] != '\r' {
			out[i] = ' '
		}
	}
	for i := 0; i < len(out); i++ {
		switch {
		case out[i] == '"':
			for i++; ; i++ {
				if i >= len(out) {
					return nil, errors.New("a string is not closed")
				}
				if out[i] == '\\' {
					i++
					continue
				}
				if out[i] == '"' {
					break
				}
			}
		case out[i] == '/' && i+1 < len(out) && out[i+1] == '/':
			for ; i < len(out) && out[i] != '\n'; i++ {
				blank(i)
			}
		case out[i] == '/' && i+1 < len(out) && out[i+1] == '*':
			blank(i)
			blank(i + 1)
			for i += 2; ; i++ {
				if i+1 >= len(out) {
					return nil, errors.New("a /* comment is not closed")
				}
				if out[i] == '*' && out[i+1] == '/' {
					blank(i)
					blank(i + 1)
					i++
					break
				}
				blank(i)
			}
		}
	}
	return out, nil
}
