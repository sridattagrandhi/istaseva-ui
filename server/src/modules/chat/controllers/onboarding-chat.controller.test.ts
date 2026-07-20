// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

// Mocked services so the controller's schema validation runs in isolation.
const agentRespond = vi.fn();
const legacyRespond = vi.fn();
vi.mock('../services/onboarding-agent.service.js', () => ({
  onboardingAgentService: { respond: agentRespond },
}));
vi.mock('../services/onboarding-chat.service.js', () => ({
  onboardingChatService: { respond: legacyRespond },
}));
vi.mock('../../../common/config/index.js', () => ({
  config: { llm: { onboardingAgentEnabled: false } },
}));
vi.mock('../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function mockRes() {
  const res: any = {};
  res.json = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  return res;
}

describe('OnboardingChatController.chat — entryType', () => {
  it('accepts entryType=transport without ValidationError', async () => {
    legacyRespond.mockResolvedValue({ message: 'ok', profile_updates: {}, action: 'none', is_complete: false });
    const { onboardingChatController } = await import('./onboarding-chat.controller.js');
    const req: any = {
      body: {
        messages: [{ role: 'user', content: 'hi' }],
        profile: {},
        displayLang: 'en',
        entryType: 'transport',
      },
      user: { id: 'u1', name: 'A', role: 'guest' },
    };
    const res = mockRes();
    const next = vi.fn();
    await onboardingChatController.chat(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
    expect(legacyRespond).toHaveBeenCalledWith(expect.objectContaining({ entryType: 'transport' }));
  });
});
