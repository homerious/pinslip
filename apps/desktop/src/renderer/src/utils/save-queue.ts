/** 同一便签的写请求按发起次序完成，失败不堵住后续重试。 */
export class SaveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  failed = false;

  run<T>(save: () => Promise<T>): Promise<T> {
    const result = this.tail.then(save);
    this.tail = result.catch(() => { this.failed = true; });
    return result;
  }

  async idle(): Promise<void> { await this.tail; }
}
