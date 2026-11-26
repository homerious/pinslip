package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"

	"pinslip/service/internal/notes"
	"pinslip/service/internal/storage"
)

func noteWriteTarget(req mcp.CallToolRequest, requireRevision bool) (id, revision string, err error) {
	id, err = req.RequireString("id")
	if err != nil || strings.TrimSpace(id) == "" {
		return "", "", errors.New("缺少必填参数 id")
	}
	raw, present := req.GetArguments()["expectedRevision"]
	if !present && !requireRevision {
		return id, "", nil
	}
	revision, ok := raw.(string)
	if !ok || strings.TrimSpace(revision) == "" {
		return "", "", errors.New("expectedRevision 必须是 read_note 返回的非空版本")
	}
	return id, revision, nil
}

func codedToolError(code, message string, current *notes.Note) (*mcp.CallToolResult, error) {
	body := map[string]any{"code": code, "message": message}
	if current != nil {
		body["folder"] = current.Folder
		body["inbox"] = current.Inbox
	}
	result, err := structured(body)
	if err != nil {
		return nil, err
	}
	result.IsError = true
	return result, nil
}

func noteWriteError(op, id string, err error) (*mcp.CallToolResult, error) {
	switch {
	case errors.Is(err, notes.ErrRevisionConflict):
		return codedToolError("NOTE_REVISION_CONFLICT", "便签已变化，请先重新 read_note 核对，再提交修改", nil)
	case errors.Is(err, storage.ErrNotFound):
		return notFoundErr(id), nil
	default:
		return serviceErr(op, err)
	}
}

func (h *toolHandler) updateNoteMetadata(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, revision, err := noteWriteTarget(req, true)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	title, titleMode, err := metadataTitle(req)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	addTags, err := tagArgument(req, "addTags")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	removeTags, err := tagArgument(req, "removeTags")
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if titleMode == nil && len(addTags) == 0 && len(removeTags) == 0 {
		return mcp.NewToolResultError("请提供要修改的标题或标签"), nil
	}
	for _, tag := range addTags {
		if slices.Contains(removeTags, tag) {
			return mcp.NewToolResultErrorf("同一个标签不能同时添加和移除：%s", tag), nil
		}
	}
	note, err := h.svc.EditExisting(id, revision, nil, func(current *notes.Note) (notes.SaveInput, error) {
		in := notes.SaveInput{Title: title, TitleManual: titleMode}
		if len(addTags) > 0 || len(removeTags) > 0 {
			in.Tags = applyTagChanges(current.Tags, addTags, removeTags)
		}
		return in, nil
	})
	if err != nil {
		return noteWriteError("修改便签元数据", id, err)
	}
	return structured(note)
}

func metadataTitle(req mcp.CallToolRequest) (string, *bool, error) {
	args := req.GetArguments()
	reset := false
	if raw, present := args["resetTitle"]; present {
		var ok bool
		reset, ok = raw.(bool)
		if !ok {
			return "", nil, errors.New("resetTitle 必须是布尔值")
		}
	}
	if raw, present := args["title"]; present {
		title, ok := raw.(string)
		if !ok || strings.TrimSpace(title) == "" {
			return "", nil, errors.New("title 必须是非空字符串")
		}
		if reset {
			return "", nil, errors.New("title 和 resetTitle 不能同时设置")
		}
		manual := true
		return title, &manual, nil
	}
	if reset {
		manual := false
		return "", &manual, nil
	}
	return "", nil, nil
}

func tagArgument(req mcp.CallToolRequest, key string) ([]string, error) {
	if _, present := req.GetArguments()[key]; !present {
		return nil, nil
	}
	tags, err := req.RequireStringSlice(key)
	if err != nil {
		return nil, fmt.Errorf("%s 必须是字符串数组", key)
	}
	for _, tag := range tags {
		if strings.TrimSpace(tag) == "" {
			return nil, fmt.Errorf("%s 不能包含空标签", key)
		}
	}
	return tags, nil
}

func applyTagChanges(current, add, remove []string) []string {
	tags := make([]string, 0, len(current)+len(add))
	for _, tag := range current {
		if !slices.Contains(remove, tag) {
			tags = append(tags, tag)
		}
	}
	for _, tag := range add {
		if !slices.Contains(tags, tag) {
			tags = append(tags, tag)
		}
	}
	return tags
}

func (h *toolHandler) moveNote(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	id, revision, err := noteWriteTarget(req, true)
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	folder, err := req.RequireString("folder")
	if err != nil {
		return mcp.NewToolResultError("folder 必须是字符串，使用空字符串表示普通便签根目录"), nil
	}
	note, err := h.svc.MoveExisting(id, folder, revision)
	if err != nil {
		if note != nil {
			return codedToolError("NOTE_MOVE_FAILED", fmt.Sprintf("移动便签失败：%v。返回字段是便签当前的位置", err), note)
		}
		return noteWriteError("移动便签", id, err)
	}
	return structured(note)
}

func (h *toolHandler) quickCapture(_ context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	content, err := req.RequireString("content")
	if err != nil || strings.TrimSpace(content) == "" {
		return mcp.NewToolResultError("缺少必填参数 content（正文不能为空）"), nil
	}
	note, err := h.svc.QuickCapture(content)
	if err != nil {
		return serviceErr("速记", err)
	}
	return structured(note)
}
