package notes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPreviewBatch(t *testing.T) {
	svc, _ := newTestService(t)
	body := strings.Repeat("中文🙂\n", 6000)
	if _, err := svc.Save("preview", SaveInput{Content: &body}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHandler(svc).Register(mux)
	for _, tc := range []struct {
		name, body    string
		status, limit int
	}{
		{"collapsed", `{"ids":["preview","missing"]}`, 200, 8192},
		{"expanded", `{"ids":["preview"],"expanded":true}`, 200, 32768},
		{"empty", `{"ids":[]}`, 400, 0},
		{"duplicate", `{"ids":["preview","preview"]}`, 400, 0},
		{"too-many", `{"ids":["1","2","3","4","5","6","7","8","9"]}`, 400, 0},
		{"path", `{"ids":["../notes"]}`, 400, 0},
		{"trailing", `{"ids":["preview"]}{}`, 400, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest("POST", "/api/notes/previews", strings.NewReader(tc.body)))
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if tc.status != 200 {
				return
			}
			var items []Preview
			if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil {
				t.Fatal(err)
			}
			if !items[0].Truncated || len(items[0].Markdown) > tc.limit || !utf8.ValidString(items[0].Markdown) || items[0].Revision == "" {
				t.Fatalf("invalid preview: %+v", items[0])
			}
			if len(items) > 1 && items[1].Error == "" {
				t.Fatal("missing note should fail individually")
			}
		})
	}
}

func TestPreviewText(t *testing.T) {
	for _, body := range []string{"", "# Short\n", strings.Repeat("🙂", 3000)} {
		got, truncated := previewText(body, 8192)
		if !utf8.ValidString(got) || len(got) > 8192 || truncated != (len(body) > 8192) {
			t.Fatal("invalid truncation")
		}
	}
}

func TestPreviewRevisionIncludesTruncatedTail(t *testing.T) {
	svc, _ := newTestService(t)
	mux := http.NewServeMux()
	NewHandler(svc).Register(mux)
	read := func() Preview {
		t.Helper()
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", "/api/notes/previews", strings.NewReader(`{"ids":["revision"]}`)))
		var items []Preview
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &items) != nil || len(items) != 1 {
			t.Fatalf("invalid response: %s", w.Body.String())
		}
		return items[0]
	}
	body := strings.Repeat("a", 9000)
	if _, err := svc.Save("revision", SaveInput{Content: &body}); err != nil {
		t.Fatal(err)
	}
	before := read()
	if again := read(); again.Revision != before.Revision {
		t.Fatal("unchanged content should have a stable revision")
	}
	body += "changed tail"
	if _, err := svc.Save("revision", SaveInput{Content: &body}); err != nil {
		t.Fatal(err)
	}
	after := read()
	if before.Markdown != after.Markdown || before.Revision == after.Revision {
		t.Fatal("revision must change even when the visible source prefix is unchanged")
	}
}
