export class RequestThrottle {
  constructor(interval = 500) {
    this.interval = interval;
    this.lastRequestTime = 0;
    this.backoffMultiplier = 1;
  }

  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const waitTime = Math.max(0, this.interval * this.backoffMultiplier - elapsed);
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    this.lastRequestTime = Date.now();
  }

  onRateLimit() {
    this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 10);
  }

  onSuccess() {
    this.backoffMultiplier = Math.max(1, this.backoffMultiplier * 0.9);
  }

  reset() {
    this.backoffMultiplier = 1;
    this.lastRequestTime = 0;
  }
}
