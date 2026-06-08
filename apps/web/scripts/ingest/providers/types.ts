import type { Runner } from '../../../lib/types';
import type { Built } from '../built';

export interface ProviderBuildOptions {
  maxEvents: number;
  maxFiles: number;
  maxHunkLines: number;
}

export interface TranscriptProvider {
  name: Runner;
  discover(): string[];
  build(file: string): Built | null;
}
