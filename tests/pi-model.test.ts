import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/server/config.js';
import { PiGovernanceModel, PI_REVIEW_TOOLS } from '../src/server/pi-model.js';

test('Pi governance is explicit and exposes only the structured submission tool', () => {
  assert.deepEqual(PI_REVIEW_TOOLS, ['submit_review']);
  assert.equal(config({ GOVERNANCE_ENGINE: 'pi' }, true).governanceEngine, 'pi');
  assert.throws(() => config({ GOVERNANCE_ENGINE: 'unknown' }, true), /direct or pi/);
  const model = new PiGovernanceModel({ enabled: true, apiKey: 'fixture', model: 'fixture', privateCodeOptIn: true });
  assert.equal(model.configured, true);
});
