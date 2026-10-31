// Package bundle turns Clack's TypeScript and CSS into the JavaScript that
// ships, using esbuild through its Go API.
//
// esbuild strips types and bundles; it does not check types. That is the
// type checker's job (see package tsgo), and the two run separately so a
// type error is reported as one, not as a bundling failure.
package bundle

import (
	"errors"
	"fmt"
	"strings"

	"github.com/evanw/esbuild/pkg/api"
)

// Engines are the oldest browser versions the output must run in: the
// release before the current one of each engine, as the plan promises.
// Written in October 2026, when Chrome and Edge were at 156, Firefox at 157
// and Safari at 26 (whose previous major release was 18). They are reviewed
// with each Clack release; moving them is a decision about who can use
// Clack, not a build detail. Safari 18 is the floor that binds in practice.
var Engines = []api.Engine{
	{Name: api.EngineChrome, Version: "155"},
	{Name: api.EngineEdge, Version: "155"},
	{Name: api.EngineFirefox, Version: "156"},
	{Name: api.EngineSafari, Version: "18"},
	{Name: api.EngineIOS, Version: "18"},
}

// Options says what to bundle and how.
type Options struct {
	// Entry is the module the bundle starts from.
	Entry string
	// Outfile names the output; with Write false it only names the files
	// in the result, so source maps can refer to them.
	Outfile string
	// Minify produces the compact build; otherwise the output is readable.
	Minify bool
	// Write puts the files on disk; otherwise they are only returned.
	Write bool
	// Banner is a comment placed at the top of the JavaScript.
	Banner string
}

// File is one output file.
type File struct {
	Path     string
	Contents []byte
}

// Build bundles o.Entry. CSS files imported by the TypeScript arrive as
// strings, which the component turns into constructable stylesheets for its
// shadow root -- so the bundle is one file, and needs no stylesheet URL or
// inline <style> that a page's Content-Security-Policy would have to allow.
func Build(o Options) ([]File, error) {
	opts := api.BuildOptions{
		EntryPoints:   []string{o.Entry},
		Outfile:       o.Outfile,
		Bundle:        true,
		Format:        api.FormatESModule,
		Platform:      api.PlatformBrowser,
		Target:        api.ES2022,
		Engines:       Engines,
		Loader:        map[string]api.Loader{".css": api.LoaderText},
		Charset:       api.CharsetUTF8,
		Sourcemap:     api.SourceMapLinked,
		LegalComments: api.LegalCommentsEndOfFile,
		Write:         o.Write,
		LogLevel:      api.LogLevelSilent,
	}
	if o.Minify {
		opts.MinifyWhitespace = true
		opts.MinifyIdentifiers = true
		opts.MinifySyntax = true
	}
	if o.Banner != "" {
		opts.Banner = map[string]string{"js": o.Banner}
	}

	result := api.Build(opts)
	if len(result.Errors) > 0 {
		return nil, errors.New(format(result.Errors, api.ErrorMessage))
	}
	// A warning from esbuild -- an import that resolves oddly, a feature the
	// targets lack -- is treated as an error: the build is either clean or
	// it is not finished.
	if len(result.Warnings) > 0 {
		return nil, errors.New(format(result.Warnings, api.WarningMessage))
	}
	files := make([]File, 0, len(result.OutputFiles))
	for _, f := range result.OutputFiles {
		files = append(files, File{Path: f.Path, Contents: f.Contents})
	}
	return files, nil
}

func format(msgs []api.Message, kind api.MessageKind) string {
	lines := api.FormatMessages(msgs, api.FormatMessagesOptions{Kind: kind, TerminalWidth: 100})
	return fmt.Sprintf("esbuild: %d %s(s)\n%s", len(msgs), kindName(kind), strings.Join(lines, ""))
}

func kindName(k api.MessageKind) string {
	if k == api.WarningMessage {
		return "warning"
	}
	return "error"
}
