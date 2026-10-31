package drivers

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"strings"
	"testing"
)

const index = `{"builds":{
  "156.0.8078":{"version":"156.0.8078.80","downloads":{"chromedriver":[
    {"platform":"mac-arm64","url":"https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/mac-arm64/chromedriver-mac-arm64.zip"},
    {"platform":"linux64","url":"https://example.com/chromedriver-linux64.zip"}
  ]}}}}`

func TestParseIndex(t *testing.T) {
	url, version, err := parseIndex([]byte(index), "156.0.8078", "mac-arm64")
	if err != nil {
		t.Fatal(err)
	}
	if version != "156.0.8078.80" || !strings.HasSuffix(url, "/mac-arm64/chromedriver-mac-arm64.zip") {
		t.Errorf("got %s %s", version, url)
	}
}

func TestParseIndexRefusesOtherHosts(t *testing.T) {
	// The index is fetched over HTTPS from Google too, but it is the one
	// thing naming where the executable comes from, so its answer is held
	// to Google's storage.
	if _, _, err := parseIndex([]byte(index), "156.0.8078", "linux64"); err == nil ||
		!strings.Contains(err.Error(), "unexpected host") {
		t.Fatalf("err = %v, want a refusal of example.com", err)
	}
}

func TestParseIndexUnknownBuild(t *testing.T) {
	if _, _, err := parseIndex([]byte(index), "157.0.1", "mac-arm64"); err == nil {
		t.Fatal("want an error for a build the index lacks")
	}
}

func TestFromTarGz(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range []struct{ name, body string }{{"README", "x"}, {"geckodriver", "\x7fELF"}} {
		tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o755, Size: int64(len(f.body)), Typeflag: tar.TypeReg})
		tw.Write([]byte(f.body))
	}
	tw.Close()
	gz.Close()

	got, err := fromTarGz(buf.Bytes(), "geckodriver")
	if err != nil || string(got) != "\x7fELF" {
		t.Fatalf("fromTarGz = %q, %v", got, err)
	}
	if _, err := fromTarGz(buf.Bytes(), "missing"); err == nil {
		t.Fatal("want an error for a missing entry")
	}
}

func TestFromZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("chromedriver-mac-arm64/chromedriver")
	w.Write([]byte("\xcf\xfa\xed\xfe"))
	zw.Close()

	got, err := fromZip(buf.Bytes(), "chromedriver-mac-arm64/chromedriver")
	if err != nil || string(got) != "\xcf\xfa\xed\xfe" {
		t.Fatalf("fromZip = %q, %v", got, err)
	}
}

func TestEveryGeckodriverDigestIsSHA256(t *testing.T) {
	for platform, a := range geckodriverAssets {
		if len(a.sha256) != 64 {
			t.Errorf("%s: digest %q is not a SHA-256", platform, a.sha256)
		}
	}
}
