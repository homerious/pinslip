package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"
)

func newTestServer() *Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return New(mux)
}

func stopServer(t *testing.T, s *Server) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
}

// 知名端口空闲时优先绑定（浏览器插件按固定地址探测）。
func TestStartPrefersDefaultPort(t *testing.T) {
	// 环境已占用（如开发机上正跑着 pinslipd）时跳过：优先绑定语义无法验证
	probe, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", DefaultPort))
	if err != nil {
		t.Skipf("知名端口已被环境占用，跳过优先绑定用例: %v", err)
	}
	probe.Close()

	s := newTestServer()
	port, fallback, err := s.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer stopServer(t, s)
	if fallback {
		t.Fatal("知名端口空闲时不应回退")
	}
	if port != DefaultPort {
		t.Fatalf("port = %d, want %d", port, DefaultPort)
	}
}

// 知名端口被占用时回退随机端口，fallback=true，服务仍可用。
func TestStartFallsBackWhenDefaultPortBusy(t *testing.T) {
	hold, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", DefaultPort))
	if err != nil {
		t.Skipf("知名端口已被环境占用，跳过回退用例: %v", err)
	}
	defer hold.Close()

	s := newTestServer()
	port, fallback, err := s.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer stopServer(t, s)
	if !fallback {
		t.Fatal("知名端口被占用应返回 fallback=true")
	}
	if port == DefaultPort || port == 0 {
		t.Fatalf("回退后应为非知名随机端口, got %d", port)
	}
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/health", port))
	if err != nil {
		t.Fatalf("回退端口应可服务: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", resp.StatusCode)
	}
}
