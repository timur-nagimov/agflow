// The Codex adapter's entry in the registry (X-6): when chosen, also without the pinned binary, which preflight
// then reports as 'binary missing'.
import type { AdapterFactory } from '../types';
import { createCodexAdapter } from './adapter';

export const codexAdapterFactory: AdapterFactory = ({ config, paths }) =>
  config.vendors.includes('codex') ? createCodexAdapter({ config, paths }) : null;
