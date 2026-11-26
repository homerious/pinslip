package mcpserver

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestFolderToolsCreateRenameAndDelete(t *testing.T) {
	root := t.TempDir()
	h, _ := newTestHandlerIn(t, root)
	const original = "work/draft"
	const renamed = "work/ready"

	for range 2 {
		result := structuredMap(t, call(t, h.createFolder, map[string]any{"path": original}))
		if result["path"] != original {
			t.Fatalf("expected created path, got %v", result)
		}
	}
	folders := structuredMap(t, call(t, h.listFolders, nil))["folders"].([]any)
	if !slices.Contains(folders, any(original)) {
		t.Fatalf("expected empty nested folder to be visible: %v", folders)
	}

	note := structuredMap(t, call(t, h.createNote, map[string]any{
		"folder": original, "content": "movetooltoken ![](../../../attachments/image.png)",
	}))
	id := note["id"].(string)
	result := structuredMap(t, call(t, h.renameFolder, map[string]any{"path": original, "name": "ready"}))
	if result["path"] != renamed || readToolNote(t, h, id)["folder"] != renamed {
		t.Fatalf("rename should preserve the note ID and return the new path: %v", result)
	}
	result = structuredMap(t, call(t, h.deleteFolder, map[string]any{"path": renamed, "mode": "move"}))
	if result["mode"] != "move" || result["path"] != renamed {
		t.Fatalf("unexpected move result: %v", result)
	}
	moved := readToolNote(t, h, id)
	if moved["folder"] != "" || !strings.Contains(moved["content"].(string), "![](../attachments/image.png)") {
		t.Fatalf("note should be in the root with a rewritten image path: %v", moved)
	}

	trashed := structuredMap(t, call(t, h.createNote, map[string]any{"folder": "trash/child", "content": "trashtooltoken"}))
	extra := filepath.Join(root, "notes", "trash", "reference.txt")
	if err := os.WriteFile(extra, []byte("keep with folder"), 0o644); err != nil {
		t.Fatal(err)
	}
	result = structuredMap(t, call(t, h.deleteFolder, map[string]any{"path": "trash", "mode": "trash"}))
	if result["mode"] != "trash" || result["path"] != "trash" {
		t.Fatalf("unexpected trash result: %v", result)
	}
	if read := call(t, h.readNote, map[string]any{"id": trashed["id"]}); !read.IsError {
		t.Fatal("trashed note must be absent from active notes")
	}
	matches := structuredMap(t, call(t, h.searchNotes, map[string]any{"query": "trashtooltoken"}))["items"].([]any)
	if len(matches) != 0 {
		t.Fatalf("trashed notes must be absent from search: %v", matches)
	}
	entries, err := filepath.Glob(filepath.Join(root, ".trash", "*-trash", "reference.txt"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected the whole tree in the recycle area: %v, %v", entries, err)
	}
	data, err := os.ReadFile(entries[0])
	if err != nil || string(data) != "keep with folder" {
		t.Fatalf("unexpected archived file: %q, %v", data, err)
	}
}

func TestFolderToolsRejectInvalidParametersAndForeignFiles(t *testing.T) {
	root := t.TempDir()
	h, _ := newTestHandlerIn(t, root)
	const folder = "mixed"
	created := structuredMap(t, call(t, h.createNote, map[string]any{"folder": folder, "content": "stay here"}))
	extra := filepath.Join(root, "notes", folder, "reference.txt")
	if err := os.WriteFile(extra, []byte("untouched"), 0o644); err != nil {
		t.Fatal(err)
	}
	if res := call(t, h.createFolder, map[string]any{"path": "../outside"}); !res.IsError {
		t.Fatal("create_folder must reject a non-vault relative path")
	}
	if res := call(t, h.renameFolder, map[string]any{"path": folder, "name": "a/b"}); !res.IsError {
		t.Fatal("rename_folder must reject a multi-segment new name")
	}
	for _, args := range []map[string]any{
		{"path": folder}, {"path": folder, "mode": "unknown"},
		{"path": "", "mode": "trash"}, {"path": folder, "mode": "move"},
	} {
		if res := call(t, h.deleteFolder, args); !res.IsError {
			t.Fatalf("delete_folder should reject %v", args)
		}
	}
	if note := readToolNote(t, h, created["id"].(string)); note["folder"] != folder {
		t.Fatalf("failed operations must leave the note in place: %v", note)
	}
	data, err := os.ReadFile(extra)
	if err != nil || string(data) != "untouched" {
		t.Fatalf("foreign file was modified: %q, %v", data, err)
	}
}
