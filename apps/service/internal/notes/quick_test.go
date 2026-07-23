package notes

import (
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"pinslip/service/internal/storage"
)

// 逐条模式（默认）：两次速记 = 两条独立便签，都在收集箱。
func TestQuickCapturePerNoteMode(t *testing.T) {
	svc, _ := newTestService(t)

	n1, err := svc.QuickCapture("第一条速记")
	if err != nil {
		t.Fatal(err)
	}
	n2, err := svc.QuickCapture("第二条速记")
	if err != nil {
		t.Fatal(err)
	}
	if n1.ID == n2.ID {
		t.Error("逐条模式应各建一条便签")
	}
	if !n1.Inbox || !n2.Inbox {
		t.Error("速记应落在收集箱 inbox")
	}
	metas, _ := svc.List()
	if len(metas) != 2 {
		t.Errorf("应有 2 条便签: %d", len(metas))
	}
}

// 聚合模式：同日两次速记进同一条「速记 YYYY-MM-DD」，条目为「### HH:mm + 空行 + 内容」。
func TestQuickCaptureDailyMode(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.SaveSettings(&storage.Settings{
		TrashRetentionDays: 30,
		QuickCaptureMode:   storage.QuickModeDaily,
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.QuickCapture("上午想到的点子"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.QuickCapture("第二条\n带换行的内容"); err != nil {
		t.Fatal(err)
	}

	// 同日聚合：仍然只有一条便签
	metas, _ := svc.List()
	if len(metas) != 1 {
		t.Fatalf("聚合模式应只有 1 条便签: %d", len(metas))
	}
	wantTitle := "速记 " + time.Now().Format("2006-01-02")
	if metas[0].Title != wantTitle {
		t.Errorf("标题应为 %q, got %q", wantTitle, metas[0].Title)
	}
	if !metas[0].Inbox {
		t.Error("聚合便签应在收集箱（与逐条落点一致）")
	}

	note, err := svc.Get(metas[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	// 两个「### HH:mm」小标题
	stamps := regexp.MustCompile(`(?m)^### \d{2}:\d{2}$`).FindAllString(note.Content, -1)
	if len(stamps) != 2 {
		t.Errorf("应有 2 个时间戳小标题（### HH:mm）: %q", note.Content)
	}
	// 格式：小标题 + 空行 + 内容，条目间空行分隔
	for _, want := range []string{"\n\n上午想到的点子", "\n\n第二条\n带换行的内容"} {
		if !strings.Contains(note.Content, want) {
			t.Errorf("条目格式应为「小标题+空行+内容」: 缺 %q\n实际: %q", want, note.Content)
		}
	}
	if !strings.Contains(note.Content, "点子\n\n### ") {
		t.Errorf("条目之间应以空行分隔: %q", note.Content)
	}
}

// 非法模式值回退逐条（QuickMode 只认精确 "daily"）。
func TestQuickModeCoercion(t *testing.T) {
	svc, _ := newTestService(t)
	if err := svc.SaveSettings(&storage.Settings{TrashRetentionDays: 30, QuickCaptureMode: "weird"}); err != nil {
		t.Fatal(err)
	}
	if svc.GetSettings().QuickMode() != storage.QuickModeNote {
		t.Error("非法模式值应回退 note")
	}
	if _, err := svc.QuickCapture("x"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.QuickCapture("y"); err != nil {
		t.Fatal(err)
	}
	metas, _ := svc.List()
	if len(metas) != 2 {
		t.Errorf("非法模式应按逐条处理: %d", len(metas))
	}
}

// settings 合并语义扩展：PUT 只带 trashRetentionDays 时，
// quickCaptureMode / quickCaptureClipboard / mcpEnabled 全部保留现值。
func TestSaveSettingsPreservesQuickFields(t *testing.T) {
	svc, _ := newTestService(t)
	h := NewHandler(svc)

	clipOff := false
	if err := svc.SaveSettings(&storage.Settings{
		TrashRetentionDays:    30,
		McpEnabled:            boolPtr(false),
		QuickCaptureMode:      storage.QuickModeDaily,
		QuickCaptureClipboard: &clipOff,
	}); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(`{"trashRetentionDays":7}`))
	rec := httptest.NewRecorder()
	h.saveSettings(rec, req)
	if rec.Code != 200 {
		t.Fatalf("PUT 应成功: %d %s", rec.Code, rec.Body.String())
	}
	s := svc.GetSettings()
	if s.QuickMode() != storage.QuickModeDaily {
		t.Error("quickCaptureMode 应保留 daily")
	}
	if s.IsQuickCaptureClipboard() {
		t.Error("quickCaptureClipboard=false 应保留")
	}
	if s.IsMcpEnabled() {
		t.Error("mcpEnabled=false 应保留")
	}

	// 显式带速记字段的 PUT 生效
	req = httptest.NewRequest("PUT", "/api/settings",
		strings.NewReader(`{"trashRetentionDays":7,"quickCaptureMode":"note","quickCaptureClipboard":true}`))
	rec = httptest.NewRecorder()
	h.saveSettings(rec, req)
	s = svc.GetSettings()
	if s.QuickMode() != storage.QuickModeNote || !s.IsQuickCaptureClipboard() {
		t.Errorf("显式速记字段应生效: mode=%s clip=%v", s.QuickCaptureMode, *s.QuickCaptureClipboard)
	}
}

// 速记字段缺省值：无配置 = 逐条 + 预填开启。
func TestQuickSettingsDefaults(t *testing.T) {
	svc, _ := newTestService(t)
	s := svc.GetSettings()
	if s.QuickMode() != storage.QuickModeNote {
		t.Error("缺省落点应为逐条 note")
	}
	if !s.IsQuickCaptureClipboard() {
		t.Error("缺省剪贴板预填应开启")
	}
}
