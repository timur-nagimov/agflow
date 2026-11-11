// The in-process hub every runner-side suite shares (design 13, 15; X-26): M2a's startHub on 127.0.0.1 and a free
// port, over a fake-clock test context with an in-memory database, test-mode timings, the scheduler created stopped
// ('manual') and no database lock. The test ticks the scheduler itself; nothing starts an attempt behind its back.
// The runner's owner gets a CLI session, as `agflow login` gives one. M2c, M2d and M2e reuse it.
import type { Credentials } from '@agflow/core';
import { createSession } from '@agflow/hub/src/auth';
import {
  HUB_RUNNER_DEFAULTS,
  type HubConfig,
  type HubContext,
  stopGraceFor,
  tx,
  wipGraceFor,
} from '@agflow/hub/src/context';
import { storeRunnerLeads } from '@agflow/hub/src/project';
import type { Scheduler, TickResult } from '@agflow/hub/src/scheduler';
import { type HubServer, startHub } from '@agflow/hub/src/server';
import { createTestContext, markHubAlive, type TestClock } from '@agflow/hub/test/helpers';

export { startRunnerAttempt } from '@agflow/hub/src/attempts';
export { mintAgentToken } from '@agflow/hub/src/auth';
export { addRunnerAttempt } from '@agflow/hub/test/helpers';

/**
 * Section 12's defaults with the hub's test mode on and the intervals a runner hears in welcome shortened, so that a
 * runner under test heartbeats every second and finds a dead link within seconds.
 */
export const TEST_HUB_TIMINGS: Partial<HubConfig> = {
  ...HUB_RUNNER_DEFAULTS,
  testMode: true,
  heartbeatMs: 1_000,
  deadLinkMs: 5_000,
  handoffMs: 5_000,
  stopGraceMs: stopGraceFor(5_000),
};

export interface TestHubOptions {
  /**
   * The hub's configuration over TEST_HUB_TIMINGS: the project's repo (a local bare origin), for one. As the hub's
   * loadConfig does, stopGraceMs and wipGraceMs follow handoffMs and runnerLeaseMs unless set here too, and the owner
   * is always among allowedUsers.
   */
  config?: Partial<HubConfig>;
  /** The runner's owner, who gets the CLI session: alice by default. */
  owner?: string;
  /** Whether the scheduler starts runner leads; off by default, since a lead would take a runner slot every tick. */
  runnerLeads?: boolean;
  /**
   * The hub's housekeeping timers (dead links, sign-ins, delivery flushes): off by default, as the fake clock does
   * not move on its own.
   */
  timers?: boolean;
}

export interface TestHub {
  /** The served origin: the runner link, the API and AttemptSpec.hubUrl. */
  url: string;
  ctx: HubContext;
  clock: TestClock;
  server: HubServer;
  scheduler: Scheduler;
  owner: string;
  /** The owner's CLI session token. */
  token: string;
  /** The credentials a runner of the owner's signs in with. */
  credentials: Credentials;
  /**
   * One scheduler tick now. The hub is marked alive first, as its timer would have ticked every tickMs, so a fake
   * clock moved further than that opens no recovery window (design 6.14).
   */
  tick(): TickResult;
  /** Closes the runner links and the port, and the database. */
  stop(): Promise<void>;
}

/** Serves M2a's hub in this process for a runner under test. */
export function startTestHub(options: TestHubOptions = {}): TestHub {
  const owner = options.owner ?? 'alice';
  const given = options.config ?? {};
  const config: Partial<HubConfig> = {
    ...TEST_HUB_TIMINGS,
    ...given,
    allowedUsers: [...new Set([...(given.allowedUsers ?? ['alice', 'bob']), owner])],
  };
  // The derived settings follow their base, as loadConfig keeps them (X-11).
  config.stopGraceMs = given.stopGraceMs ?? stopGraceFor(config.handoffMs ?? HUB_RUNNER_DEFAULTS.handoffMs);
  config.wipGraceMs = given.wipGraceMs ?? wipGraceFor(config.runnerLeaseMs ?? HUB_RUNNER_DEFAULTS.runnerLeaseMs);
  const { ctx, clock } = createTestContext(config);
  // In a transaction of its own, as its callers run it.
  tx(ctx, () => storeRunnerLeads(ctx, options.runnerLeads ?? false));
  // Before the port opens, so that a failure here leaves nothing serving.
  const token = createSession(ctx, owner, 'cli');
  const server = startHub(ctx, {
    port: 0,
    hostname: '127.0.0.1',
    scheduler: 'manual',
    dbLock: false,
    timers: options.timers ?? false,
  });
  // The port is known only now: starts tell runners and agents this URL.
  ctx.config.publicUrl = server.url;
  const scheduler = server.scheduler;
  if (scheduler === null) throw new Error('startHub made no scheduler');
  let stopped = false;
  return {
    url: server.url,
    ctx,
    clock,
    server,
    scheduler,
    owner,
    token,
    credentials: { hubUrl: server.url, token, user: owner },
    tick() {
      markHubAlive(ctx);
      return scheduler.tick();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop({ closeDatabase: true });
    },
  };
}
