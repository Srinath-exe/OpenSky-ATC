/*
  Feature-contract gating (05-TEST-STRATEGY §2.4). Gated specs stay in the matrix and report as
  "skipped" until `__atcTest.features()[flag]` is true; once it flips, the spec must pass.

    test('STCA predictive alert @gated:stca', async ({ sim }) => {
      await skipUnless(sim, 'stca');
      ...
    });
*/
import { test } from '@playwright/test';
import type { FeatureFlag } from '@/lib/sim/testApi';
import type { SimApi } from './simApi';

export type { FeatureFlag };

/** Skip the current test when `flag` is not wired in the running build. Call after the game is open. */
export async function skipUnless(sim: SimApi, flag: FeatureFlag): Promise<void> {
  const on = await sim.hasFeature(flag);
  test.skip(!on, `feature "${flag}" not implemented (features().${flag} === false)`);
}

/** Skip when any of the flags is off. */
export async function skipUnlessAll(sim: SimApi, ...flags: FeatureFlag[]): Promise<void> {
  const f = await sim.features();
  const missing = flags.filter((k) => !f[k]);
  test.skip(missing.length > 0, `features not implemented: ${missing.join(', ')}`);
}
