import { BRIDGE_ANSWERS } from '@agflow/core';

export type HubErrorStatus = 400 | 401 | 403 | 404 | 409 | 415 | 426 | 429 | 502 | 504;

export class HubError extends Error {
  constructor(
    readonly status: HubErrorStatus,
    readonly code: string,
    message: string,
    /** More fields for the answer's body, next to error and message. */
    readonly extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'HubError';
  }
}

export const badRequest = (message: string) => new HubError(400, 'bad_request', message);
export const unauthorized = (message = 'sign in first') => new HubError(401, 'unauthorized', message);
export const forbidden = (message: string) => new HubError(403, 'forbidden', message);
export const notFound = (what: string) => new HubError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new HubError(409, 'conflict', message);
export const unsupportedMediaType = (message: string) => new HubError(415, 'unsupported_media_type', message);
export const upgradeRequired = (message: string) => new HubError(426, 'upgrade_required', message);

/** An agent token that no longer works; reason is its attempt's end reason, null when there is none or it is unknown. */
export const attemptEnded = (reason: string | null) =>
  new HubError(401, 'attempt_ended', BRIDGE_ANSWERS.attemptEnded(reason), { reason });
/** An agent token whose attempt a restore is about to re-fence (design 6.5). */
export const attemptRefenced = () => new HubError(401, 'attempt_refenced', BRIDGE_ANSWERS.attemptRefenced);
/** An agent token on a route outside the agents' allowlist (design 6.5). */
export const agentNotAllowed = (message: string) => new HubError(403, 'agent_not_allowed', message);
