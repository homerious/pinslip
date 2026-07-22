import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getVaultPath } from '../settings';

const PORT_LINE = /PINSLIP_PORT=(\d+)/;
const START_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 3;

/** 未选择保险库时 ensureStarted 的拒绝原因（调用方据此走设置流程） */
export const VAULT_NOT_SET = 'VAULT_NOT_SET';

/**
 * Go 本地服务进程管理：
 * - 开发模式：go run ./cmd/pinslipd（cwd = apps/service）
 * - 生产模式：拉起 resources/service/ 下随包携带的二进制
 * - 端口发现：解析 stdout 中的 PINSLIP_PORT=<port> 行
 * - 崩溃自动重启（最多 MAX_RESTARTS 次）
 */
export class GoProcess {
  private child: ChildProcess | null = null;
  private port = 0;
  private restarts = 0;
  private stopping = false;
  private readyPromise: Promise<number> | null = null;

  /** 确保服务已启动，返回端口。并发调用共享同一次启动。未设置保险库时拒绝。 */
  ensureStarted(): Promise<number> {
    if (!getVaultPath()) {
      return Promise.reject(new Error(VAULT_NOT_SET));
    }
    if (!this.readyPromise) {
      this.readyPromise = this.spawnAndWaitPort();
    }
    return this.readyPromise;
  }

  getPort(): number {
    return this.port;
  }

  /** 重启服务（切换保险库后调用）：杀旧进程、清状态、按新配置拉起。 */
  async restart(): Promise<number> {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
    this.readyPromise = null;
    this.restarts = 0;
    // 给旧进程一点退出时间，避免端口/文件占用
    await new Promise((r) => setTimeout(r, 400));
    this.stopping = false;
    return this.ensureStarted();
  }

  private resolveCommand(): { cmd: string; args: string[]; cwd?: string } {
    if (app.isPackaged) {
      const name = process.platform === 'win32' ? 'pinslipd.exe' : 'pinslipd';
      return { cmd: path.join(process.resourcesPath, 'service', name), args: [] };
    }
    const goBin = process.env.PINSLIP_GO || 'go';
    // 开发时 app 路径是 apps/desktop，服务源码在同级 apps/service
    const serviceDir = path.resolve(app.getAppPath(), '..', 'service');
    return { cmd: goBin, args: ['run', './cmd/pinslipd'], cwd: serviceDir };
  }

  private spawnAndWaitPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const { cmd, args, cwd } = this.resolveCommand();
      if (cwd && !existsSync(cwd)) {
        reject(new Error(`Go 服务目录不存在: ${cwd}`));
        return;
      }
      console.log(`[go] spawn: ${cmd} ${args.join(' ')} ${cwd ? `(cwd=${cwd})` : ''}`);

      // 数据目录注入：Go 侧 PINSLIP_DATA_DIR 优先于其默认路径
      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, PINSLIP_DATA_DIR: getVaultPath() ?? '' },
      });
      this.child = child;

      const timer = setTimeout(() => {
        reject(new Error(`等待 Go 服务端口超时（${START_TIMEOUT_MS / 1000}s）`));
      }, START_TIMEOUT_MS);

      let buffer = '';
      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        buffer += text;
        process.stdout.write(`[go] ${text}`);
        const m = buffer.match(PORT_LINE);
        if (m) {
          this.port = Number(m[1]);
          clearTimeout(timer);
          resolve(this.port);
        }
      });
      child.stderr?.on('data', (chunk) => {
        process.stderr.write(`[go:err] ${chunk.toString()}`);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Go 服务拉起失败: ${err.message}`));
      });
      child.on('exit', (code) => {
        this.child = null;
        this.readyPromise = null;
        if (this.stopping) return;
        console.error(`[go] 进程退出 code=${code}`);
        if (this.restarts < MAX_RESTARTS) {
          this.restarts++;
          console.log(`[go] 1s 后重启（第 ${this.restarts}/${MAX_RESTARTS} 次）`);
          setTimeout(() => {
            this.ensureStarted().catch((err) =>
              console.error('[go] 重启失败:', err),
            );
          }, 1000);
        }
      });
    });
  }

  /** 停止服务（应用退出前调用）。 */
  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
  }
}
