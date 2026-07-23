// engine.go — 同步循环状态机（设计稿 M3-2）：
//
//	启动 pull（已配置时）→ watching
//	  │ 文件变更防抖 3 分钟无变更 → auto-commit
//	  │ 定时（可配 pushIntervalMin，默认 10 分钟）→ commit + pull + push（push 前必 pull）
//	  │ 失败 backoff 1m→5m→15m 封顶，恢复自动追上
//	Stop 时给 5s 窗口尽力 push，失败不拦退出。
//
// 变更信号来源：复用 internal/watch（fsnotify + 去抖回调），
// 监听 notes/ inbox/ attachments/ 三个内容目录——天然避开 .git 自身噪声，
// 与索引重建链路共用同一事件源语义。未采用定时 git status 轮询：
// watch 已提供精确去抖且零额外依赖，轮询只会更慢更糙。
//
// 断网不阻塞使用：所有 git 操作异步于 API 写路径，失败只反映到 status。
package gitsync

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"pinslip/service/internal/watch"
)

// 默认定时参数（测试可覆盖）。
var (
	defaultDebounce     = 3 * time.Minute
	defaultPushInterval = 10 * time.Minute
	defaultBackoff      = []time.Duration{1 * time.Minute, 5 * time.Minute, 15 * time.Minute}
)

// stopPushWindow 退出时尽力 push 的时间窗（设计稿：5s）。
const stopPushWindow = 5 * time.Second

// Logger 抽象日志，pkg/utils.Logger 满足。
type Logger interface {
	Info(msg string, kv ...any)
	Error(msg string, kv ...any)
}

// Engine 是 git 同步引擎：配置 + 仓库 + 同步循环 + 状态快照。
type Engine struct {
	vaultDir string
	logger   Logger

	// 定时参数（NewEngine 后、Start 前可覆盖，用于测试）；
	// pushInterval 为 0 时跟随配置 cfg.PushIntervalMin（生产路径），
	// >0 是测试覆盖（配置粒度分钟、最低 1m，测试需要 ms 级间隔）
	debounce     time.Duration
	pushInterval time.Duration
	backoff      []time.Duration

	// mu 保护 cfg/repo 与状态快照字段
	mu              sync.RWMutex
	cfg             *SyncConfig
	repo            *Repo
	lastSyncAt      time.Time
	lastError       string
	running         bool
	conflictedFiles []string

	// opMu 串行化一切 git 操作（循环、sync-now、auto-commit、reconfigure）
	opMu sync.Mutex

	triggerCh chan chan error // sync-now：请求通道 + 结果回传
	stopCh    chan struct{}
	loopDone  chan struct{}
	stopWatch func()
}

// NewEngine 创建引擎并加载已保存配置（不发起任何网络操作）。
// 配置文件损坏时返回错误，但引擎仍以未配置状态可用（err 非 nil, engine 非 nil）。
func NewEngine(vaultDir string, logger Logger) (*Engine, error) {
	cfg, err := loadSyncConfig(vaultDir)
	e := &Engine{
		vaultDir:     vaultDir,
		logger:       logger,
		cfg:          cfg,
		debounce:     defaultDebounce,
		pushInterval: 0, // 0 = 跟随配置（测试可覆盖为固定值）
		backoff:      defaultBackoff,
		triggerCh:    make(chan chan error),
	}
	return e, err
}

// Start 若配置且启用则启动同步循环（含首次 pull）；幂等。
func (e *Engine) Start() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running || e.cfg == nil || !e.cfg.Enabled {
		return
	}
	e.startLocked()
}

// startLocked 启动循环 goroutine 与文件监听（调用方持 e.mu）。
func (e *Engine) startLocked() {
	e.stopCh = make(chan struct{})
	e.loopDone = make(chan struct{})
	e.running = true

	// 变更信号：复用 watch 包（fsnotify + 去抖），目录不存在自动跳过。
	// 防抖窗口内反复变更只打一批 commit。
	stop, err := watch.Start(
		[]string{
			filepath.Join(e.vaultDir, "notes"),
			filepath.Join(e.vaultDir, "inbox"),
			filepath.Join(e.vaultDir, "attachments"),
		},
		e.debounce,
		func() { e.autoCommit() },
		func(err error) { e.logger.Error("git 同步目录监听错误", "error", err) },
	)
	if err != nil {
		e.logger.Error("git 同步目录监听启动失败（继续运行）", "error", err)
		stop = func() {}
	}
	e.stopWatch = stop

	go e.run()
}

// stopLoopLocked 发起循环停止（调用方持 e.mu）：标记停止并关闭信号通道，
// 返回等待完成所需的通道与监听停止函数。
// 拆成两阶段的原因：等待 loopDone 时绝不能持有 e.mu——在飞的 syncCycle
// 结束前要拿 e.mu 写状态，持锁等待会互锁（服务关停/重配时真实死锁）。
func (e *Engine) stopLoopLocked() (done chan struct{}, stopWatch func()) {
	if !e.running {
		return nil, nil
	}
	e.running = false
	close(e.stopCh)
	return e.loopDone, e.stopWatch
}

// waitLoopStopped 等待循环退出并清理 repo（不持 e.mu 调用）。
func (e *Engine) waitLoopStopped(done chan struct{}, stopWatch func()) {
	if done == nil {
		return
	}
	if stopWatch != nil {
		stopWatch()
	}
	<-done
	e.mu.Lock()
	e.repo = nil
	e.mu.Unlock()
}

// Stop 停止同步循环，并在 5s 窗口内尽力 commit+pull+push 一次（失败不拦退出）。
func (e *Engine) Stop() {
	e.mu.Lock()
	repo := e.repo
	cfg := e.cfg
	done, stopWatch := e.stopLoopLocked()
	e.mu.Unlock()
	e.waitLoopStopped(done, stopWatch)

	if repo == nil || cfg == nil {
		return
	}
	e.opMu.Lock()
	defer e.opMu.Unlock()
	if _, n, err := repo.CommitAll(); err != nil {
		e.logger.Error("退出前提交失败（忽略）", "error", err)
	} else if n > 0 {
		e.logger.Info("退出前已提交", "files", n)
	}
	if _, err := repo.Pull(); err != nil {
		e.logger.Error("退出前拉取失败（忽略）", "error", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), stopPushWindow)
	defer cancel()
	if err := repo.PushContext(ctx); err != nil {
		e.logger.Error("退出前推送失败（忽略）", "error", err)
	}
}

// run 同步循环主 goroutine。
func (e *Engine) run() {
	defer close(e.loopDone)

	// 启动即同步一次（含首次接入时的 Connect），之后按 push 定时器走。
	// 失败进入 backoff：1m→5m→15m 封顶，成功后恢复配置节奏。
	backoffIdx := 0
	wait := e.currentPushInterval()
	if err := e.syncCycle(); err != nil {
		wait = e.backoff[0]
		backoffIdx = 1
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()

	for {
		select {
		case <-e.stopCh:
			return
		case reply := <-e.triggerCh:
			err := e.syncCycle()
			if err == nil {
				backoffIdx = 0
			}
			reply <- err
			timer.Reset(e.nextWait(err == nil, &backoffIdx))
		case <-timer.C:
			err := e.syncCycle()
			timer.Reset(e.nextWait(err == nil, &backoffIdx))
		}
	}
}

// nextWait 根据本次成败计算下次同步间隔（成功恢复配置间隔，失败推进 backoff）。
func (e *Engine) nextWait(ok bool, idx *int) time.Duration {
	if ok {
		*idx = 0
		return e.currentPushInterval()
	}
	d := e.backoff[min(*idx, len(e.backoff)-1)]
	*idx++
	return d
}

// currentPushInterval 当前生效的自动推拉间隔：测试覆盖优先（pushInterval > 0），
// 否则用配置值（normalize 已收敛到 1~1440 分钟），未配置回退默认 10m。
// 配置经 Reconfigure 保存后循环会停下重建，run() 新 timer 即按新值走，无需重启服务。
func (e *Engine) currentPushInterval() time.Duration {
	if e.pushInterval > 0 {
		return e.pushInterval
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.cfg != nil && e.cfg.PushIntervalMin >= minPushIntervalMin {
		return time.Duration(e.cfg.PushIntervalMin) * time.Minute
	}
	return defaultPushInterval
}

// syncCycle 一轮完整同步：Connect（必要时）→ commit-all → pull → push。
// pull 永远先于 push，把冲突暴露在本地而不是远端拒绝。
func (e *Engine) syncCycle() error {
	e.opMu.Lock()
	defer e.opMu.Unlock()

	e.mu.RLock()
	repo, cfg := e.repo, e.cfg
	e.mu.RUnlock()
	if cfg == nil || !cfg.Enabled {
		return nil
	}

	if repo == nil {
		var err error
		repo, err = Connect(e.vaultDir, *cfg)
		e.mu.Lock()
		if err != nil {
			e.lastError = err.Error()
			e.mu.Unlock()
			e.logger.Error("git 同步接入失败", "error", err)
			return err
		}
		e.repo = repo
		e.mu.Unlock()
		e.logger.Info("git 同步已接入", "url", cfg.URL, "branch", cfg.Branch)
	}

	_, n, err := repo.CommitAll()
	if err != nil {
		return e.failCycle("提交本地变更失败", err)
	}
	outcome, err := repo.Pull()
	if err != nil {
		return e.failCycle("拉取远端失败", err)
	}
	if err := repo.Push(); err != nil {
		return e.failCycle("推送失败", err)
	}

	e.mu.Lock()
	e.lastSyncAt = time.Now()
	e.lastError = ""
	e.conflictedFiles = scanConflictedFiles(e.vaultDir)
	e.mu.Unlock()

	if n > 0 || outcome.Kind == PullMerged || outcome.Kind == PullFastForward {
		e.logger.Info("git 同步完成",
			"committed", n, "pull", pullKindName(outcome.Kind),
			"conflicts", len(outcome.ConflictedFiles), "binaryConflicts", len(outcome.BinaryConflicts))
	}
	return nil
}

// failCycle 记录失败并返回错误（token 绝不进日志：只记操作名与 go-git 错误）。
func (e *Engine) failCycle(op string, err error) error {
	e.mu.Lock()
	e.lastError = op + ": " + err.Error()
	e.mu.Unlock()
	e.logger.Error("git 同步失败", "op", op, "error", err)
	return err
}

// autoCommit 防抖触发：只提交，不推送（推送走 10 分钟定时器）。
func (e *Engine) autoCommit() {
	e.opMu.Lock()
	defer e.opMu.Unlock()
	e.mu.RLock()
	repo := e.repo
	e.mu.RUnlock()
	if repo == nil {
		return
	}
	if _, n, err := repo.CommitAll(); err != nil {
		e.logger.Error("自动提交失败", "error", err)
	} else if n > 0 {
		e.logger.Info("自动提交完成", "files", n)
		e.mu.Lock()
		e.conflictedFiles = scanConflictedFiles(e.vaultDir)
		e.mu.Unlock()
	}
}

// SyncNow 立即同步一轮（commit+pull+push），阻塞至完成并返回错误（可为 nil）。
func (e *Engine) SyncNow() error {
	e.mu.RLock()
	running, enabled := e.running, e.cfg != nil && e.cfg.Enabled
	e.mu.RUnlock()
	if !enabled {
		return nil
	}
	if !running {
		// 引擎未跑（例如刚 PUT 配置但接入失败）：直接同步执行一轮
		return e.syncCycle()
	}
	reply := make(chan error, 1)
	select {
	case e.triggerCh <- reply:
		return <-reply
	case <-time.After(2 * time.Minute):
		return context.DeadlineExceeded
	}
}

// Reconfigure 应用新配置：持久化 → 停旧循环 → 启用则同步接入并起新循环。
// 接入失败返回错误（配置已落盘，状态里可见 lastError，下轮循环自动重试）。
// token 语义与渲染层对齐：空串 = 不修改已存 token（表单不回显 token，
// 用户只改地址/分支时不应把凭证抹掉）；要清除 token 只能整体停用重配。
func (e *Engine) Reconfigure(in SyncConfig) error {
	if in.Token == "" && e.cfg != nil {
		in.Token = e.cfg.Token
	}
	if err := in.normalize(); err != nil {
		return err
	}
	if err := saveSyncConfig(e.vaultDir, &in); err != nil {
		return err
	}

	e.mu.Lock()
	done, stopWatch := e.stopLoopLocked()
	e.cfg = &in
	e.lastError = ""
	e.mu.Unlock()
	e.waitLoopStopped(done, stopWatch)

	if !in.Enabled {
		return nil
	}

	// 同步接入一次：失败立即把原因反馈给调用方（同时落 lastError）。
	e.opMu.Lock()
	repo, err := Connect(e.vaultDir, in)
	e.opMu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	if err != nil {
		e.lastError = err.Error()
		return err
	}
	e.repo = repo
	// Connect 内的首次提交+push 本身就是一轮完整同步：立即落 lastSyncAt。
	// 否则要等循环里首个 syncCycle 跑完才有值，PUT 响应与首个轮询窗口内
	// UI 会错误显示「从未同步」
	e.lastSyncAt = time.Now()
	e.startLocked()
	return nil
}

// Disable 停用同步：保留 .git 与已存配置（仅置 enabled=false），停止循环。
func (e *Engine) Disable() error {
	e.mu.Lock()
	done, stopWatch := e.stopLoopLocked()
	if e.cfg != nil {
		e.cfg.Enabled = false
		if err := saveSyncConfig(e.vaultDir, e.cfg); err != nil {
			e.mu.Unlock()
			return err
		}
	}
	e.mu.Unlock()
	e.waitLoopStopped(done, stopWatch)
	return nil
}

// Status 是当前同步状态快照（API 响应模型；绝不包含 token）。
type Status struct {
	Enabled         bool      `json:"enabled"`
	Configured      bool      `json:"configured"`
	URL             string    `json:"url,omitempty"`
	Username        string    `json:"username,omitempty"`
	Branch          string    `json:"branch,omitempty"`
	LastSyncAt      time.Time `json:"lastSyncAt,omitempty"`
	LastError       string    `json:"lastError,omitempty"`
	Ahead           int       `json:"ahead"`
	Behind          int       `json:"behind"`
	ConflictedFiles []string  `json:"conflictedFiles"`
	// PushIntervalMin 当前生效的自动推拉间隔（分钟）
	PushIntervalMin int `json:"pushIntervalMin"`
}

// GetStatus 汇总状态：ahead/behind 现场算（基于最近一次 fetch 的远端位置，
// 不做网络请求）；conflictedFiles 现场扫 vault 里含 markers 的 .md。
func (e *Engine) GetStatus() Status {
	e.mu.RLock()
	st := Status{
		Enabled:         e.cfg != nil && e.cfg.Enabled,
		Configured:      e.cfg != nil,
		LastSyncAt:      e.lastSyncAt,
		LastError:       e.lastError,
		ConflictedFiles: e.conflictedFiles,
		PushIntervalMin: defaultPushIntervalMin,
	}
	if e.cfg != nil {
		st.URL = e.cfg.URL
		st.Username = e.cfg.Username
		st.Branch = e.cfg.Branch
		st.PushIntervalMin = e.cfg.PushIntervalMin
	}
	repo := e.repo
	e.mu.RUnlock()

	if repo != nil {
		if ahead, behind, err := repo.AheadBehind(); err == nil {
			st.Ahead, st.Behind = ahead, behind
		}
	}
	// 现场扫描为准：覆盖「pull 下来的 markers 文件」与「用户已手工解决」两侧变化
	st.ConflictedFiles = scanConflictedFiles(e.vaultDir)
	if st.ConflictedFiles == nil {
		st.ConflictedFiles = []string{}
	}
	return st
}

// scanConflictedFiles 扫描 notes/ 与 inbox/ 下含冲突标记行（^<<<<<<< ）的
// .md 文件，返回 vault 相对路径（正斜杠，排序）。
func scanConflictedFiles(vaultDir string) []string {
	var out []string
	for _, sub := range []string{"notes", "inbox"} {
		root := filepath.Join(vaultDir, sub)
		_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() || filepath.Ext(p) != ".md" {
				return nil
			}
			data, err := os.ReadFile(p)
			if err != nil {
				return nil
			}
			if HasConflictMarkers(string(data)) {
				rel, err := filepath.Rel(vaultDir, p)
				if err == nil {
					out = append(out, filepath.ToSlash(rel))
				}
			}
			return nil
		})
	}
	sort.Strings(out)
	return out
}

// HasConflictMarkers 报告内容是否含 git 冲突标记行（^<<<<<<< ）。
// 与 notes/index 两包中的同名检测保持一致（格式锚点是 conflictMarkerOurs）。
func HasConflictMarkers(content string) bool {
	return strings.HasPrefix(content, "<<<<<<< ") || strings.Contains(content, "\n<<<<<<< ")
}

// pullKindName 供日志输出。
func pullKindName(k PullKind) string {
	switch k {
	case PullUpToDate:
		return "up-to-date"
	case PullLocalAhead:
		return "local-ahead"
	case PullFastForward:
		return "fast-forward"
	case PullMerged:
		return "merged"
	}
	return "unknown"
}
