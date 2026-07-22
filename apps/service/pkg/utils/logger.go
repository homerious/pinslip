// Package utils 提供可跨项目复用的通用工具。
package utils

import (
	"log"
	"os"
)

// Logger 是带简单级别的标准输出日志器。
type Logger struct {
	l *log.Logger
}

func NewLogger() *Logger {
	return &Logger{l: log.New(os.Stdout, "", log.LstdFlags)}
}

func (l *Logger) Info(msg string, kv ...any) {
	l.l.Println(append([]any{"[INFO]", msg}, kv...)...)
}

func (l *Logger) Error(msg string, kv ...any) {
	l.l.Println(append([]any{"[ERROR]", msg}, kv...)...)
}

func (l *Logger) Fatal(msg string, kv ...any) {
	l.Error(msg, kv...)
	os.Exit(1)
}
