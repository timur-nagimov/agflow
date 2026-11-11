// The Claude Code adapter's entry in the registry (X-6): createClaudeAdapter, with the runner's own environment.
import type { AdapterFactory } from '../types';
import { createClaudeAdapter } from './factory';

export const claudeAdapterFactory: AdapterFactory = (input) => createClaudeAdapter(input);
