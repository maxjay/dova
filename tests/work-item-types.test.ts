import { describe, it, expect } from 'vitest';
import { categoryOf, pickNextInProgressState, decideStartTransition, type WorkItemState } from '../src/lib/work-item-types.js';

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

describe('pickNextInProgressState', () => {
  it('picks the state whose category is InProgress', () => {
    expect(pickNextInProgressState(bugStates)?.name).toBe('Active');
  });

  it('returns null when no state has an InProgress category', () => {
    expect(pickNextInProgressState(bugStates.filter((s) => s.category !== 'InProgress'))).toBeNull();
  });
});

describe('decideStartTransition', () => {
  it('transitions a Proposed-category item into the InProgress state', () => {
    expect(decideStartTransition(bugStates, 'New')).toEqual({ action: 'transition', toState: 'Active' });
  });

  it('skips (never regresses) an item already in the InProgress category', () => {
    const result = decideStartTransition(bugStates, 'Active');
    expect(result.action).toBe('skip');
  });

  it('skips an item already Resolved or Completed', () => {
    expect(decideStartTransition(bugStates, 'Resolved').action).toBe('skip');
    expect(decideStartTransition(bugStates, 'Closed').action).toBe('skip');
  });

  it('skips with a clear reason when the state category cannot be determined', () => {
    const result = decideStartTransition(bugStates, 'SomeUnknownState');
    expect(result).toEqual({
      action: 'skip',
      reason: 'Could not determine the category of state "SomeUnknownState" for this work item type.',
    });
  });

  it('skips with a clear reason when the type has no InProgress-category state at all', () => {
    const kanbanOnlyStates: WorkItemState[] = [{ name: 'To Do', category: 'Proposed', color: '' }];
    const result = decideStartTransition(kanbanOnlyStates, 'To Do');
    expect(result.action).toBe('skip');
  });
});
