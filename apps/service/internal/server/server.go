// Package server 负责 HTTP 服务装配、中间件与生命周期。
package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
)

// Server 包装 http.Server，绑定在回环地址的随机端口上。
type Server struct {
	httpServer *http.Server
	listener   net.Listener
}

func New(handler http.Handler) *Server {
	return &Server{
		httpServer: &http.Server{Handler: withCORS(handler)},
	}
}

// DefaultPort 是浏览器插件约定的知名端口（插件读不了本地发现文件，
// 只能按固定地址探测）。被占用时 Start 回退随机端口。
const DefaultPort = 17639

// Start 开始监听：优先绑 127.0.0.1:DefaultPort；被占用则回退 127.0.0.1:0
// （随机端口）并返回 fallback=true，由调用方打日志。
// 只绑回环地址：本地服务绝不能暴露到局域网。
func (s *Server) Start() (port int, fallback bool, err error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", DefaultPort))
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return 0, false, err
		}
		fallback = true
	}
	s.listener = ln
	go func() {
		// Serve 只在 Shutdown 时返回错误，忽略
		_ = s.httpServer.Serve(ln)
	}()
	return ln.Addr().(*net.TCPAddr).Port, fallback, nil
}

// Shutdown 优雅关闭。
func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}

// withCORS 允许任意来源访问（服务只绑回环，风险可控），
// 并响应 Chrome 私有网络访问（PNA）预检，避免 file:// 页面请求被拦。
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
