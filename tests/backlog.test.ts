import { describe, it, expect } from 'vitest';
import { isPortfolioType, type BacklogConfiguration } from '../src/lib/backlog.js';

const config: BacklogConfiguration = {
  portfolioBacklogs: [
    { id: 'epics', name: 'Epics', workItemTypes: [{ name: 'Epic' }] },
    { id: 'features', name: 'Features', workItemTypes: [{ name: 'Feature' }] },
  ],
  requirementBacklog: { id: 'stories', name: 'Stories', workItemTypes: [{ name: 'User Story' }] },
  taskBacklog: { id: 'tasks', name: 'Tasks', workItemTypes: [{ name: 'Task' }] },
};

describe('isPortfolioType', () => {
  it('is true for a type in any portfolio backlog level, case-insensitively', () => {
    expect(isPortfolioType(config, 'Epic')).toBe(true);
    expect(isPortfolioType(config, 'feature')).toBe(true);
  });

  it('is false for the requirement/task backlog types', () => {
    expect(isPortfolioType(config, 'User Story')).toBe(false);
    expect(isPortfolioType(config, 'Task')).toBe(false);
  });

  it('is false, not a crash, when portfolioBacklogs is missing entirely (e.g. a Kanban-only/Basic process)', () => {
    expect(isPortfolioType({}, 'Epic')).toBe(false);
  });
});
