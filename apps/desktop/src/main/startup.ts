/** 隐藏仅影响启动入口；首次引导或无托盘时保留管理器入口。 */
export function shouldShowManager(argv: string[], hasVault: boolean, trayIcon: boolean, loginHidden = false): boolean {
  return !hasVault || !trayIcon || !(argv.includes('--hidden') || loginHidden);
}
