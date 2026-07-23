// pinslipd 是 PinSlip 的本地服务：文件引擎 + SQLite 索引 + HTTP API。
// 由 Electron 主进程拉起，监听 127.0.0.1 随机端口，
// 启动后向 stdout 打印一行 PINSLIP_PORT=<port> 供主进程解析。
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"pinslip/service/internal/config"
	"pinslip/service/internal/gitsync"
	"pinslip/service/internal/index"
	"pinslip/service/internal/notes"
	"pinslip/service/internal/server"
	"pinslip/service/internal/storage"
	"pinslip/service/internal/watch"
	"pinslip/service/pkg/utils"
)

const version = "0.1.0"

func main() {
	logger := utils.NewLogger()

	cfg, err := config.Load()
	if err != nil {
		logger.Fatal("加载配置失败", "error", err)
	}
	if err := cfg.EnsureDirs(); err != nil {
		logger.Fatal("创建数据目录失败", "error", err)
	}

	engine := storage.NewEngine(cfg.NotesDir(), cfg.InboxDir(), cfg.AttachDir())

	db, err := index.Open(cfg.DBPath())
	if err != nil {
		logger.Fatal("打开索引数据库失败", "error", err)
	}
	defer db.Close()

	svc := notes.NewService(engine, db)
	if err := svc.Reindex(); err != nil {
		logger.Error("重建索引失败（继续运行）", "error", err)
	}

	// 回收区自动清理：按 vault 设置（.pinslip/settings.json）删除超期条目，
	// 条目年龄以删除时刻的名称时间戳为准；<= 0 天 = 不清理
	if removed, err := svc.AutoCleanTrash(); err != nil {
		logger.Error("回收区自动清理失败（继续运行）", "error", err)
	} else if removed > 0 {
		logger.Info("回收区自动清理完成", "removed", removed)
	}

	// 运行中保险：监听 notes/inbox 目录，外部改文件（同步盘/手动编辑）去抖后重建索引。
	// 进程关闭期间的变更由上面的启动 Reindex 兜底，两者构成双保险。
	stopWatch, err := watch.Start(
		[]string{cfg.NotesDir(), cfg.InboxDir()},
		300*time.Millisecond,
		func() {
			if err := svc.Reindex(); err != nil {
				logger.Error("监听触发重建索引失败", "error", err)
			}
		},
		func(err error) { logger.Error("目录监听错误", "error", err) },
	)
	if err != nil {
		logger.Error("启动目录监听失败（继续运行）", "error", err)
	} else {
		defer stopWatch()
	}

	// git 同步引擎：已配置且启用时启动同步循环（启动 pull → 防抖 commit → 定时 push）
	syncEngine, err := gitsync.NewEngine(cfg.DataDir, logger)
	if err != nil {
		// 配置损坏不阻塞服务启动：引擎按未配置状态运行（status API 可见 enabled=false）
		logger.Error("加载 git 同步配置失败（按未配置继续运行）", "error", err)
	}
	syncEngine.Start()
	defer syncEngine.Stop() // Stop 内含退出前 5s 尽力 push

	srv := server.New(server.NewRouter(notes.NewHandler(svc), gitsync.NewHandler(syncEngine), version))
	port, err := srv.Start()
	if err != nil {
		logger.Fatal("启动 HTTP 服务失败", "error", err)
	}

	// 这行输出是 Electron 主进程发现端口的约定，格式不可改
	fmt.Printf("PINSLIP_PORT=%d\n", port)
	writePortFile(port)
	logger.Info("pinslipd 已启动", "port", port, "dataDir", cfg.DataDir)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = os.Remove(portFilePath())
	logger.Info("pinslipd 已关闭")
}

func portFilePath() string {
	return filepath.Join(os.TempDir(), "pinslip-port.json")
}

// writePortFile 把端口写入临时文件（stdout 之外的备用发现途径）。
func writePortFile(port int) {
	content := fmt.Sprintf(`{"port":%d,"pid":%d}`, port, os.Getpid())
	if err := os.WriteFile(portFilePath(), []byte(content), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "写入端口文件失败:", err)
	}
}
