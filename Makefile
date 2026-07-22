# PinSlip Makefile —— 跨语言编排入口（pnpm 只管 TS，Go 由 scripts 处理）

.PHONY: dev build-service build-desktop build-all run-service clean

# 开发模式：启动 Electron（自动拉起 Go 服务）
dev:
	pnpm dev

# 编译 Go 服务（并拷贝到 desktop 的 resources/service/）
build-service:
	pnpm build:service

# 构建桌面端
build-desktop:
	pnpm build

# 构建全部
build-all:
	pnpm build:all

# 独立调试 Go 服务
run-service:
	cd apps/service && go run ./cmd/pinslipd

# 清理构建产物
clean:
	rm -rf apps/service/bin apps/service/pinslipd.exe
	rm -rf apps/desktop/out apps/desktop/resources/service
