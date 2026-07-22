// Package server 负责 HTTP 服务装配、中间件与生命周期。
package server

import (
	"context"
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

// Start 开始监听（127.0.0.1:0），返回实际端口。
// 只绑回环地址：本地服务绝不能暴露到局域网。
func (s *Server) Start() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	s.listener = ln
	go func() {
		// Serve 只在 Shutdown 时返回错误，忽略
		_ = s.httpServer.Serve(ln)
	}()
	return ln.Addr().(*net.TCPAddr).Port, nil
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
