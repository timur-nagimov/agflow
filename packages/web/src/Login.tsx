import { useEffect, useState } from 'react';
import { type AuthConfig, api } from './api';

const RETURN_KEY = 'agflow.returnTo';

/** The hub sends people back to "/" after sign-in, so the page they asked for is kept here. */
function rememberReturnHash(): void {
  if (window.location.hash) sessionStorage.setItem(RETURN_KEY, window.location.hash);
}

export function restoreReturnHash(): void {
  const hash = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  if (hash && !window.location.hash) window.location.hash = hash;
}

export function Login() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [login, setLogin] = useState('');

  useEffect(() => {
    api.authConfig().then(setConfig, (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
  }, []);

  const go = (url: string) => {
    rememberReturnHash();
    window.location.assign(url);
  };

  return (
    <main className="login">
      <div className="login-card">
        <p className="wordmark big">
          agflow <span className="lamp tone-done pulse" />
        </p>
        <p className="login-project">{config ? config.project : ' '}</p>
        {config?.mode === 'github' ? (
          <button className="primary wide" onClick={() => go('/auth/github?returnTo=/')}>
            Sign in with GitHub
          </button>
        ) : null}
        {config?.mode === 'dev' ? (
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              const user = login.trim();
              if (user) go(`/auth/dev?user=${encodeURIComponent(user)}&returnTo=/`);
            }}
          >
            <label>
              GitHub login
              <input
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                autoFocus
                autoComplete="username"
                placeholder="octocat"
              />
            </label>
            <button className="primary wide" disabled={!login.trim()}>
              Sign in
            </button>
            <p className="hint">Development sign-in: any login on the hub's allowed list works without a password.</p>
          </form>
        ) : null}
        {failure ? <p className="error">Cannot reach the hub: {failure}</p> : null}
      </div>
    </main>
  );
}
