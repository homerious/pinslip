package mcpserver

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"

	"pinslip/service/internal/notes"
	"pinslip/service/internal/storage"
)

func readToolNote(t *testing.T, h *toolHandler, id string) map[string]any {
	t.Helper()
	note := structuredMap(t, call(t, h.readNote, map[string]any{"id": id}))
	if revision, ok := note["revision"].(string); !ok || revision == "" {
		t.Fatalf("read_note must return a revision, got %v", note)
	}
	return note
}

func toolErrorCode(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	if !res.IsError {
		t.Fatalf("expected tool error, got %+v", res)
	}
	body, ok := res.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("expected structured tool error, got %+v", res)
	}
	return body["code"].(string)
}

func TestUpdateMetadataPreservesBodyAndExternalProperties(t *testing.T) {
	root := t.TempDir()
	h, _ := newTestHandlerIn(t, root)
	const id = "metadata"
	const body = "# Derived title\n\nMarkdown ![](../attachments/image.png)\n"
	filename := filepath.Join(root, "notes", id+".md")
	if err := os.WriteFile(filename, []byte("---\nid: metadata\ntitle: Old\ntags: [keep, remove]\nproject: [one, two]\n---\n\n"+body), 0o644); err != nil {
		t.Fatal(err)
	}
	initial := readToolNote(t, h, id)
	args := map[string]any{"id": id, "title": "Manual", "addTags": []string{"keep", "new"}, "removeTags": []string{"remove"}}
	if res := call(t, h.updateNoteMetadata, args); !strings.Contains(errText(t, res), "expectedRevision") {
		t.Fatal("metadata edit must require the original version")
	}
	args["expectedRevision"] = initial["revision"]
	edited := structuredMap(t, call(t, h.updateNoteMetadata, args))
	if edited["content"] != body || edited["title"] != "Manual" || edited["titleManual"] != true ||
		!reflect.DeepEqual(edited["tags"], []any{"keep", "new"}) {
		t.Fatalf("unexpected metadata result: %v", edited)
	}
	paths, err := filepath.Glob(filepath.Join(root, "notes", "Manual-*.md"))
	if err != nil || len(paths) != 1 {
		t.Fatalf("manual title should rename the Markdown file: %v, %v", paths, err)
	}
	data, err := os.ReadFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	fm, diskBody, err := storage.ParseNote(data)
	if err != nil || diskBody != body || !reflect.DeepEqual(fm.Extra["project"], []any{"one", "two"}) {
		t.Fatalf("body or external properties changed: %q, %v", data, err)
	}
	latest := readToolNote(t, h, id)
	if latest["revision"] == initial["revision"] {
		t.Fatal("metadata changes must advance the revision")
	}
	reset := structuredMap(t, call(t, h.updateNoteMetadata, map[string]any{
		"id": id, "expectedRevision": latest["revision"], "resetTitle": true,
	}))
	if reset["title"] != "Derived title" || reset["titleManual"] == true {
		t.Fatalf("restoring automatic title failed: %v", reset)
	}
}

func TestVersionedWritesRejectExternalChanges(t *testing.T) {
	root := t.TempDir()
	h, _ := newTestHandlerIn(t, root)
	filename := filepath.Join(root, "notes", "external.md")
	original := "---\nid: external\ntitle: Original\n---\n\nOriginal body\n"
	if err := os.WriteFile(filename, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	initial := readToolNote(t, h, "external")
	external := strings.Replace(original, "Original body", "External edit", 1)
	if err := os.WriteFile(filename, []byte(external), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		tool func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error)
		args map[string]any
	}{
		{"update", h.updateNote, map[string]any{"content": "replacement"}},
		{"patch", h.patchNote, map[string]any{"oldString": "Original body", "newString": "replacement"}},
		{"append", h.appendNote, map[string]any{"content": "additional"}},
		{"delete", h.deleteNote, map[string]any{}},
		{"metadata", h.updateNoteMetadata, map[string]any{"addTags": []string{"work"}}},
		{"move", h.moveNote, map[string]any{"folder": "nested"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.args["id"], tc.args["expectedRevision"] = "external", initial["revision"]
			if code := toolErrorCode(t, call(t, tc.tool, tc.args)); code != "NOTE_REVISION_CONFLICT" {
				t.Fatalf("expected version conflict, got %s", code)
			}
			data, err := os.ReadFile(filename)
			if err != nil || string(data) != external {
				t.Fatalf("conflict modified the note: %q, %v", data, err)
			}
		})
	}
}

func TestMoveNoteAndLegacyMoveFailure(t *testing.T) {
	root := t.TempDir()
	h, svc := newTestHandlerIn(t, root)
	const id = "picture"
	body := "Picture\n\n![](../attachments/image.png)"
	if _, err := svc.Save(id, notes.SaveInput{Content: &body}); err != nil {
		t.Fatal(err)
	}
	initial := readToolNote(t, h, id)
	moved := structuredMap(t, call(t, h.moveNote, map[string]any{
		"id": id, "expectedRevision": initial["revision"], "folder": "a/b",
	}))
	if moved["id"] != id || moved["folder"] != "a/b" || !strings.Contains(moved["content"].(string), "../../../attachments/image.png") {
		t.Fatalf("move should return the new location and image prefix, got %v", moved)
	}
	latest := readToolNote(t, h, id)
	if latest["revision"] == initial["revision"] {
		t.Fatal("move did not change the revision")
	}
	invalid := call(t, h.updateNote, map[string]any{"id": id, "content": "unexpected", "folder": "invalid:name"})
	if !strings.Contains(errText(t, invalid), "非法字符") || readToolNote(t, h, id)["revision"] != latest["revision"] {
		t.Fatal("invalid destination should fail before saving")
	}
	if err := os.WriteFile(filepath.Join(root, "notes", "occupied"), []byte("file"), 0o644); err != nil {
		t.Fatal(err)
	}
	failedMove := call(t, h.moveNote, map[string]any{"id": id, "expectedRevision": latest["revision"], "folder": "occupied"})
	if toolErrorCode(t, failedMove) != "NOTE_MOVE_FAILED" || failedMove.StructuredContent.(map[string]any)["folder"] != "a/b" {
		t.Fatalf("failed move should report actual location: %v", failedMove)
	}
	partial := call(t, h.updateNote, map[string]any{"id": id, "content": "changed", "folder": "occupied"})
	if toolErrorCode(t, partial) != "NOTE_PARTIAL_WRITE" {
		t.Fatal("legacy update should explicitly identify a partial write")
	}
	actual := readToolNote(t, h, id)
	if actual["folder"] != "a/b" || !strings.HasPrefix(actual["content"].(string), "changed") {
		t.Fatalf("unexpected actual note state: %v", actual)
	}
}

func TestConcurrentRevisionedAppendPreservesTitle(t *testing.T) {
	h, _ := newTestHandler(t)
	created := structuredMap(t, call(t, h.createNote, map[string]any{"title": "Custom", "content": "Different heading"}))
	id := created["id"].(string)
	initial := readToolNote(t, h, id)
	type outcome struct {
		res *mcp.CallToolResult
		err error
	}
	outcomes := make(chan outcome, 2)
	for _, content := range []string{"first addition", "second addition"} {
		go func() {
			res, err := h.appendNote(context.Background(), mcp.CallToolRequest{Params: mcp.CallToolParams{
				Arguments: map[string]any{"id": id, "expectedRevision": initial["revision"], "content": content},
			}})
			outcomes <- outcome{res, err}
		}()
	}
	successes := 0
	for range 2 {
		result := <-outcomes
		if result.err != nil {
			t.Fatal(result.err)
		}
		if !result.res.IsError {
			successes++
		} else if code := toolErrorCode(t, result.res); code != "NOTE_REVISION_CONFLICT" {
			t.Fatalf("expected revision error, got %s", code)
		}
	}
	note := readToolNote(t, h, id)
	if successes != 1 || note["title"] != "Custom" || strings.Count(note["content"].(string), "addition") != 1 {
		t.Fatalf("expected one append and original title, got %d successful calls, note %v", successes, note)
	}
}

func TestQuickCaptureUsesVaultMode(t *testing.T) {
	for _, mode := range []string{storage.QuickModeNote, storage.QuickModeDaily} {
		t.Run(mode, func(t *testing.T) {
			h, svc := newTestHandler(t)
			settings := svc.GetSettings()
			settings.QuickCaptureMode = mode
			if err := svc.SaveSettings(settings); err != nil {
				t.Fatal(err)
			}
			first := structuredMap(t, call(t, h.quickCapture, map[string]any{"content": "first capture"}))
			second := structuredMap(t, call(t, h.quickCapture, map[string]any{"content": "second capture"}))
			if first["inbox"] != true || second["inbox"] != true || (first["id"] == second["id"]) != (mode == storage.QuickModeDaily) {
				t.Fatalf("unexpected quick capture target: %v / %v", first, second)
			}
			if mode == storage.QuickModeDaily && !strings.Contains(second["content"].(string), "first capture") {
				t.Fatalf("daily quick capture lost the first entry: %v", second)
			}
			if res := call(t, h.quickCapture, map[string]any{"content": " \t"}); !res.IsError {
				t.Fatal("whitespace-only capture should fail")
			}
		})
	}
}
