// Package watch 提供 vault 目录监听：文件事件去抖后触发回调（索引重建）。
//
// 定位：进程存活期间保持索引新鲜的「运行中保险」；
// 进程关闭期间的外部变更由启动时的全量 Reindex 兜底（双保险策略）。
package watch

import (
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Start 监听 dirs 下的文件变更，debounce 窗口内的事件合并为一次 fire 调用。
//
// 注意点：
//   - 启动时递归 Add 所有已存在子目录（notes/ 支持嵌套文件夹）；
//   - 运行中新建的子目录在事件循环里动态 Add，保持监听覆盖；
//   - 目录不存在/不可用时跳过而非失败（例如 inbox 尚未创建）；
//   - 自己 API 保存的文件写入也会触发——去抖后多重建一次索引，无害且兜底。
//
// 返回停止函数（幂等）。
func Start(dirs []string, debounce time.Duration, fire func(), onError func(error)) (func(), error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	// 已 watch 路径集合（并发安全）：避免重复 Add；目录 rename 后
	// fsnotify 只报旧路径的 RENAME 事件、拿不到新路径，靠 fire 前的
	// 全量补扫把新目录重新纳入监听
	var mu sync.Mutex
	watched := map[string]struct{}{}
	add := func(p string) {
		mu.Lock()
		defer mu.Unlock()
		if _, ok := watched[p]; ok {
			return
		}
		if err := w.Add(p); err == nil {
			watched[p] = struct{}{}
		}
	}
	for _, d := range dirs {
		_ = filepath.Walk(d, func(p string, info os.FileInfo, err error) error {
			if err != nil || !info.IsDir() {
				return nil
			}
			add(p)
			return nil
		})
	}
	if len(watched) == 0 {
		_ = w.Close()
		return func() {}, nil
	}

	done := make(chan struct{})
	go func() {
		var timer *time.Timer
		var timerC <-chan time.Time
		for {
			select {
			case <-done:
				if timer != nil {
					timer.Stop()
				}
				return
			case ev, ok := <-w.Events:
				if !ok {
					return
				}
				// 新建目录：动态纳入监听（嵌套文件夹）
				if ev.Has(fsnotify.Create) {
					if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
						add(ev.Name)
					}
				}
				if timer == nil {
					timer = time.NewTimer(debounce)
					timerC = timer.C
				} else {
					timer.Reset(debounce)
				}
			case err, ok := <-w.Errors:
				if !ok {
					return
				}
				if onError != nil {
					onError(err)
				}
			case <-timerC:
				timer = nil
				timerC = nil
				// 补扫：目录 rename/移动后新路径不在监听内（fsnotify 报的是
				// 旧路径 RENAME），去抖触发时全量 walk 一次保证覆盖
				for _, d := range dirs {
					_ = filepath.Walk(d, func(p string, info os.FileInfo, err error) error {
						if err != nil || !info.IsDir() {
							return nil
						}
						add(p)
						return nil
					})
				}
				fire()
			}
		}
	}()

	var stopped bool
	return func() {
		if stopped {
			return
		}
		stopped = true
		close(done)
		_ = w.Close()
	}, nil
}
