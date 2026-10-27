import { verificationCode } from '@agflow/core';
import type { HubContext } from '../context';
import { badRequest } from '../errors';
import type { App } from './app';

const CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function escapeHtml(text: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, (char) => entities[char] as string);
}

/** JSON that is safe to place inside an inline script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · agflow</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}code{font-size:1.4rem;letter-spacing:.1em}button,input{font:inherit;padding:.3rem .8rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

export function mountCliLoginPage(app: App, ctx: HubContext): void {
  app.get('/cli-login', (c) => {
    const code = c.req.query('code') ?? '';
    const label = (c.req.query('label') ?? 'a computer').slice(0, 200);
    if (!CODE_PATTERN.test(code)) throw badRequest('this sign-in link is malformed; run agflow login again');
    const self = `/cli-login?code=${encodeURIComponent(code)}&label=${encodeURIComponent(label)}`;
    const p = c.get('principal');
    if (!p || p.via !== 'web' || p.agent) {
      if (ctx.config.auth === 'github') return c.redirect(`/auth/github?returnTo=${encodeURIComponent(self)}`);
      return c.html(
        page(
          'Sign in to agflow',
          `<form method="get" action="/auth/dev"><input type="hidden" name="returnTo" value="${escapeHtml(self)}"><p><label>GitHub login <input name="user" required autofocus></label></p><button type="submit">Sign in</button></form>`,
        ),
      );
    }
    return c.html(
      page(
        'Approve CLI sign-in',
        `<p>Allow <b>${escapeHtml(label)}</b> to use agflow as <b>${escapeHtml(p.user)}</b>?</p>
<p>Approve only if your terminal shows this code:</p>
<p><code>${escapeHtml(verificationCode(code))}</code></p>
<button id="approve" type="button">Approve</button>
<p id="result" role="status"></p>
<script>
const code = ${scriptJson(code)};
const label = ${scriptJson(label)};
document.getElementById('approve').addEventListener('click', async () => {
  const result = document.getElementById('result');
  const response = await fetch('/api/cli-login/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, label }),
  });
  const data = await response.json().catch(() => ({}));
  result.textContent = response.ok
    ? 'Approved. You can close this tab and return to the terminal.'
    : 'Approval failed: ' + (data.message || response.status);
});
</script>`,
      ),
    );
  });
}
