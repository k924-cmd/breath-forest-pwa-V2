import { MOCK_ENVIRONMENT } from '../mocks/environment.js?v=20260807-10';

export async function getEnvironmentSnapshot() {
  return { ...MOCK_ENVIRONMENT, source: 'mock', freshness: 'fresh', observedAt: new Date().toISOString(), uiMockOnly: true };
}
