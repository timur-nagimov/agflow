// Service side effects for a refused CLI sign-in (design 7.1, X-7, X-11, X-38). The link owns probing and recovery.
import type { Logger } from '../log';
import type { ServiceHealth } from '../ops/health';
import type { RunnerHandle } from '../runner';
import type { Notifier } from '../seams';

export interface NeedsLoginState {
  on: boolean;
  since: number | null;
  reason: string | null;
}

export interface NeedsLoginOptions {
  health: Pick<ServiceHealth, 'setNeedsLogin'>;
  notifier: Notifier;
  logger: Logger;
  /** The handle may not exist yet, including while the service waits for credentials.json. */
  runner: () => Pick<RunnerHandle, 'interruptAgents' | 'pushWipNow'> | null;
  hubUrl: () => string | null;
  now?: () => number;
}

/** The person's reading of a reason: the service's own credential wait, M2b's refused token, or the reason itself. */
function explain(reason: string): string {
  if (reason === 'not signed in') return 'not signed in; waiting for credentials.json';
  if (reason === 'the hub refused the CLI token') {
    return "the hub refused the CLI's sign-in; the sign-in expired or was revoked";
  }
  return reason;
}

export class NeedsLogin {
  private current: NeedsLoginState = { on: false, since: null, reason: null };

  constructor(private readonly options: NeedsLoginOptions) {}

  state(): NeedsLoginState {
    return { ...this.current };
  }

  enter(reason: string): void {
    if (this.current.on) return;
    this.current = { on: true, since: (this.options.now ?? Date.now)(), reason };
    this.options.health.setNeedsLogin(true);
    const login = `agflow login --hub ${this.options.hubUrl() ?? '<url>'}`;
    const body = `${explain(reason)}; run ${login}`;
    this.options.logger.warn(body, { reason });
    // A slow desktop notification must not delay interrupting the agents or spend their WIP grace.
    void this.attempt('notification', () =>
      this.options.notifier.notify({
        key: 'needs_login',
        title: 'agflow needs login',
        body,
      }),
    );
    void this.interruptAndPush();
  }

  leave(): void {
    if (!this.current.on) return;
    this.current = { on: false, since: null, reason: null };
    this.options.health.setNeedsLogin(false);
    this.options.logger.info('runner left needs_login; the hub accepted the CLI sign-in');
  }

  private async interruptAndPush(): Promise<void> {
    await this.attempt('agents', async () => {
      const runner = this.options.runner();
      if (runner === null) return;
      await this.attempt('interrupt', () => runner.interruptAgents({ outage: true }));
      await this.attempt('WIP push', () => runner.pushWipNow());
    });
  }

  private async attempt(action: string, run: () => unknown): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.options.logger.warn(`needs_login ${action} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
