import { describe, it, expect } from 'vitest';
import { categoryOf, type WorkItemState } from '../src/lib/work-item-types.js';

const bugStates: WorkItemState[] = [
  { name: 'New', category: 'Proposed', color: '' },
  { name: 'Active', category: 'InProgress', color: '' },
  { name: 'Resolved', category: 'Resolved', color: '' },
  { name: 'Closed', category: 'Completed', color: '' },
];

describe('categoryOf', () => {
  it('matches case-insensitively', () => {
    expect(categoryOf(bugStates, 'active')).toBe('InProgress');
  });

  it('returns null for an unknown state name', () => {
    expect(categoryOf(bugStates, 'Nonexistent')).toBeNull();
  });
});
