export type HubErrorStatus = 400 | 401 | 403 | 404 | 409;

export class HubError extends Error {
  constructor(
    readonly status: HubErrorStatus,
    readonly code: string,
    message: string,
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
