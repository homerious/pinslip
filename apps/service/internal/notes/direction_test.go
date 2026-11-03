package notes

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestDirectionRoundTrip(t *testing.T) {
	for _, direction := range []string{"ltr", "rtl"} {
		t.Run(direction, func(t *testing.T) {
			svc, store := newTestService(t)
			body := "# یادداشت\n\n- [ ] سلام 123 (hello)"
			if _, err := svc.Save("direction01", SaveInput{Content: &body, Direction: &direction}); err != nil {
				t.Fatal(err)
			}
			reloaded := NewService(store, svc.idx)
			note, err := reloaded.Get("direction01")
			if err != nil || note.Direction != direction || strings.TrimSpace(note.Content) != body {
				t.Fatalf("reload: %+v %v", note, err)
			}
			if _, err := svc.Save("direction01", SaveInput{Pin: boolPtr(true)}); err != nil {
				t.Fatal(err)
			}
			note, _ = svc.Get("direction01")
			if note.Direction != direction {
				t.Fatal("partial update cleared direction")
			}
			p, _, _ := store.Locate("direction01")
			before, _ := os.ReadFile(p)
			for _, invalid := range []string{"auto", "RTL", "invalid"} {
				_, err := svc.Save("direction01", SaveInput{Direction: &invalid})
				if !errors.Is(err, ErrInvalidDirection) {
					t.Fatalf("invalid: %v", err)
				}
				after, _ := os.ReadFile(p)
				if string(before) != string(after) {
					t.Fatal("invalid input modified disk")
				}
			}
			empty := ""
			if _, err := svc.Save("direction01", SaveInput{Direction: &empty}); err != nil {
				t.Fatal(err)
			}
			data, _ := os.ReadFile(p)
			if strings.Contains(string(data), "direction:") {
				t.Fatal("empty direction not omitted")
			}
			note, _ = svc.Get("direction01")
			if note.Direction != "" || !note.Pin || strings.TrimSpace(note.Content) != body {
				t.Fatalf("clear: %+v", note)
			}
		})
	}
}

func TestDirectionHTTP(t *testing.T) {
	svc, _ := newTestService(t)
	mux := http.NewServeMux()
	NewHandler(svc).Register(mux)
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{"content":"hello","direction":"rtl"}`, 200},
		{`{"direction":"auto"}`, 400},
		{`{"content":"updated"}`, 200},
		{`{"direction":""}`, 200},
	} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("PUT", "/api/notes/httpdirection", strings.NewReader(tc.body)))
		if w.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.body, w.Code, w.Body.String())
		}
	}
}

func TestExternalDirectionFallback(t *testing.T) {
	for _, direction := range []string{"invalid", "auto", "rtl"} {
		t.Run(direction, func(t *testing.T) {
			svc, store := newTestService(t)
			if _, err := svc.Save("externaldirection", SaveInput{Content: strPtr("body")}); err != nil {
				t.Fatal(err)
			}
			p, _, _ := store.Locate("externaldirection")
			data, _ := os.ReadFile(p)
			data = []byte(strings.Replace(string(data), "---\n", "---\ndirection: "+direction+"\n", 1))
			if err := os.WriteFile(p, data, 0o600); err != nil {
				t.Fatal(err)
			}
			note, err := svc.Get("externaldirection")
			want := ""
			if direction == "rtl" {
				want = direction
			}
			if err != nil || note.Direction != want {
				t.Fatalf("external: %+v %v", note, err)
			}
		})
	}
}
