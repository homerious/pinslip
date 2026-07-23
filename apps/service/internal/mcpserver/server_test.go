package mcpserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pinslip/service/internal/storage"
)

// mcpEnabled=false 的设置（测试关闭态用）。
var storageSettingsOff = storage.Settings{TrashRetentionDays: 30, McpEnabled: func() *bool { b := false; return &b }()}

// HTTP 层冒烟：经真实 Streamable HTTP 端点跑 initialize → tools/list，
// 验证 SDK 接线（服务名/版本、11 个工具全部注册）——工具语义由 tools_test 覆盖。
func TestMCPEndpointSmoke(t *testing.T) {
	h, svc := newTestHandler(t)
	handler := NewHandler(svc, h.sync, "9.9.9-test")

	post := func(body string, sessionID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		// Streamable HTTP 客户端必须同时接受 JSON 与 SSE
		req.Header.Set("Accept", "application/json, text/event-stream")
		if sessionID != "" {
			req.Header.Set("Mcp-Session-Id", sessionID)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// initialize：拿回服务标识与（有状态模式下）session id
	rec := post(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
		"protocolVersion":"2025-03-26","capabilities":{},
		"clientInfo":{"name":"smoke-test","version":"0"}}}`, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("initialize 应 200, got %d: %s", rec.Code, rec.Body.String())
	}
	initBody := rec.Body.String()
	if !strings.Contains(initBody, `"pinslip"`) || !strings.Contains(initBody, `"9.9.9-test"`) {
		t.Errorf("initialize 响应应含服务名与版本: %s", initBody)
	}
	sessionID := rec.Header().Get("Mcp-Session-Id")
	// 协议要求 initialize 之后客户端先发 initialized 通知
	rec = post(`{"jsonrpc":"2.0","method":"notifications/initialized"}`, sessionID)
	if rec.Code >= 400 {
		t.Fatalf("initialized 通知不应失败, got %d: %s", rec.Code, rec.Body.String())
	}

	// tools/list：11 个工具一个不少
	rec = post(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`, sessionID)
	if rec.Code != http.StatusOK {
		t.Fatalf("tools/list 应 200, got %d: %s", rec.Code, rec.Body.String())
	}
	// 响应可能是 JSON 或 SSE 帧（data: {...}），统一抠出 JSON 部分
	body := rec.Body.String()
	if i := strings.Index(body, "data: "); i >= 0 {
		body = strings.TrimSpace(body[i+6:])
	}
	var rpc struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &rpc); err != nil {
		t.Fatalf("tools/list 响应不可解析: %v\n%s", err, body)
	}
	if rpc.Error != nil {
		t.Fatalf("tools/list 返回错误: %s", rpc.Error.Message)
	}
	want := []string{
		"search_notes", "list_notes", "read_note", "create_note", "update_note",
		"append_note", "delete_note", "list_tags", "list_folders",
		"sync_now", "sync_status",
	}
	got := map[string]bool{}
	for _, tool := range rpc.Result.Tools {
		got[tool.Name] = true
	}
	for _, name := range want {
		if !got[name] {
			t.Errorf("tools/list 缺工具 %s（实到 %d 个）", name, len(rpc.Result.Tools))
		}
	}
	if len(rpc.Result.Tools) != len(want) {
		t.Errorf("工具数应为 %d, got %d", len(want), len(rpc.Result.Tools))
	}

	// 开关关闭：连 initialize 都 404
	if err := svc.SaveSettings(&storageSettingsOff); err != nil {
		t.Fatal(err)
	}
	rec = post(`{"jsonrpc":"2.0","id":3,"method":"initialize","params":{
		"protocolVersion":"2025-03-26","capabilities":{},
		"clientInfo":{"name":"smoke-test","version":"0"}}}`, "")
	if rec.Code != http.StatusNotFound {
		t.Errorf("mcpEnabled=false 时 /mcp 应 404, got %d", rec.Code)
	}
}
