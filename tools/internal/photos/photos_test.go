package photos

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTheManifestLoads(t *testing.T) {
	list, err := Load("../../../design/photos.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) == 0 {
		t.Fatal("no photos")
	}
	for _, p := range list {
		if len(p.SHA256) != 64 || p.Author == "" || p.Caption == "" || p.Width == 0 || p.Height == 0 {
			t.Errorf("%s: incomplete entry %+v", p.File, p)
		}
	}
}

func TestLoadRefuses(t *testing.T) {
	for name, entry := range map[string]string{
		"a path":       `{"file":"../x.jpg","url":"https://upload.wikimedia.org/x","licence":"CC0"}`,
		"another host": `{"file":"x.jpg","url":"https://example.com/x.jpg","licence":"CC0"}`,
		"a licence":    `{"file":"x.jpg","url":"https://upload.wikimedia.org/x","licence":"CC BY-SA 4.0"}`,
	} {
		p := filepath.Join(t.TempDir(), "photos.json")
		os.WriteFile(p, []byte(`{"photos":[`+entry+`]}`), 0o644)
		if _, err := Load(p); err == nil {
			t.Errorf("%s: want a refusal", name)
		}
	}
}
