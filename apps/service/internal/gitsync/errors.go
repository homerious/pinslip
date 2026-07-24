// errors.go — 用户可见错误的稳定 code（HTTP 契约）。
//
// 背景：Go 错误消息是中文硬编码（MCP 工具与日志继续消费原文，不改文案），
// renderer 展示层按 code → i18n key 映射翻译；没有 code 或不认识的 code
// 原样展示服务端 message 兜底。code 是跨端稳定契约：增删改必须同步
// renderer 语言包的 serverError.* 一节。
package gitsync

import "errors"

// 同步错误码（renderer serverError.SYNC_* 一一对应）。
const (
	// 启用同步但未提供仓库地址（normalize 校验）
	CodeSyncURLRequired = "SYNC_URL_REQUIRED"
	// vault 已是 git 仓库但不是 PinSlip 同步仓库（缺 .pinslip-repo 标记）
	CodeSyncLocalNotPinslipRepo = "SYNC_LOCAL_NOT_PINSLIP_REPO"
	// 远端仓库不是 PinSlip 同步仓库（缺标记，防历史纠缠）
	CodeSyncRemoteNotPinslipRepo = "SYNC_REMOTE_NOT_PINSLIP_REPO"
	// 无法访问远端（地址/用户名/token/网络，go-git 不细分，归一类）
	CodeSyncRemoteAccess = "SYNC_REMOTE_ACCESS"
	// 远端没有配置的分支
	CodeSyncBranchNotFound = "SYNC_BRANCH_NOT_FOUND"
	// 本地与远端没有共同祖先（unrelated histories）
	CodeSyncUnrelatedHistories = "SYNC_UNRELATED_HISTORIES"
	// 工作区有未提交变更会被远端覆盖 / 无法合并
	CodeSyncDirtyWorktree = "SYNC_DIRTY_WORKTREE"
	// 接入失败兜底（未带具体 code 的 Connect 错误）
	CodeSyncConnectFailed = "SYNC_CONNECT_FAILED"
	// 提交本地变更失败
	CodeSyncCommitFailed = "SYNC_COMMIT_FAILED"
	// 拉取远端失败
	CodeSyncPullFailed = "SYNC_PULL_FAILED"
	// 推送失败
	CodeSyncPushFailed = "SYNC_PUSH_FAILED"
)

// codedError 给错误贴稳定 code；Error/Unwrap 透传原错误，文案不变。
type codedError struct {
	code string
	err  error
}

func (e *codedError) Error() string { return e.err.Error() }
func (e *codedError) Unwrap() error { return e.err }

// withCode 给错误贴 code；错误链上已有 code 时保留内层（内层更具体）。
func withCode(code string, err error) error {
	if err == nil {
		return nil
	}
	var ce *codedError
	if errors.As(err, &ce) {
		return err
	}
	return &codedError{code: code, err: err}
}

// codeOf 提取错误链上的 code；无 code 返回空串（调用方决定兜底 code 或省略）。
func codeOf(err error) string {
	var ce *codedError
	if errors.As(err, &ce) {
		return ce.code
	}
	return ""
}

// codeOr 提取错误链上的 code，无 code 时回退 fallback（引擎按操作给兜底 code）。
func codeOr(err error, fallback string) string {
	if c := codeOf(err); c != "" {
		return c
	}
	return fallback
}
