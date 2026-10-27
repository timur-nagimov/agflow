import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Me, api, onSessionEnded } from './api';
import { ErrorBox, Loading } from './components';
import { LiveProvider } from './live';
import { Login, restoreReturnHash } from './Login';
import { Shell } from './Shell';

type State =
  | { kind: 'checking' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; me: Me }
  | { kind: 'failed'; error: Error };

export function App() {
  const [state, setState] = useState<State>({ kind: 'checking' });

  const check = useCallback(() => {
    setState({ kind: 'checking' });
    api.me().then(
      (me) => {
        restoreReturnHash();
        setState({ kind: 'signed-in', me });
      },
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 401) setState({ kind: 'signed-out' });
        else setState({ kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
  }, []);

  useEffect(() => {
    onSessionEnded(() => setState({ kind: 'signed-out' }));
    check();
  }, [check]);

  const signOut = useCallback(async () => {
    await api.signOut().catch(() => undefined);
    setState({ kind: 'signed-out' });
  }, []);

  switch (state.kind) {
    case 'checking':
      return (
        <div className="splash">
          <Loading />
        </div>
      );
    case 'failed':
      return (
        <div className="splash">
          <ErrorBox error={state.error} onRetry={check} />
        </div>
      );
    case 'signed-out':
      return <Login />;
    case 'signed-in':
      return (
        <LiveProvider>
          <Shell me={state.me} onSignOut={signOut} />
        </LiveProvider>
      );
  }
}
