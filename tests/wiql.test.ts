import { describe, it, expect } from 'vitest';
import { buildWiql, wiqlString, isCurrentUserToken } from '../src/lib/wiql.js';

describe('wiqlString', () => {
  it('wraps a plain value in single quotes', () => {
    expect(wiqlString('Bug')).toBe("'Bug'");
  });

  it('escapes an embedded single quote by doubling it', () => {
    expect(wiqlString("O'Brien")).toBe("'O''Brien'");
  });
});

describe('isCurrentUserToken', () => {
  it('matches "me" and "@me" case-insensitively', () => {
    expect(isCurrentUserToken('me')).toBe(true);
    expect(isCurrentUserToken('Me')).toBe(true);
    expect(isCurrentUserToken('@me')).toBe(true);
    expect(isCurrentUserToken('@Me')).toBe(true);
  });

  it('does not match an actual username', () => {
    expect(isCurrentUserToken('mearnhart@contoso.com')).toBe(false);
    expect(isCurrentUserToken('Meredith')).toBe(false);
  });
});

describe('buildWiql', () => {
  it('builds a simple SELECT with a title CONTAINS filter', () => {
    const wiql = buildWiql({
      where: [
        { field: 'System.TeamProject', op: '=', value: 'MyProject' },
        { field: 'System.Title', op: 'CONTAINS', value: 'login bug' },
      ],
    });
    expect(wiql).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'MyProject' AND [System.Title] CONTAINS 'login bug'"
    );
  });

  it('renders an IN clause with numeric values unquoted', () => {
    const wiql = buildWiql({ where: [{ field: 'System.Id', op: 'IN', value: [1, 2, 3] }] });
    expect(wiql).toBe('SELECT [System.Id] FROM WorkItems WHERE [System.Id] IN (1, 2, 3)');
  });

  it('renders a macro (e.g. @Me) unquoted, unlike a literal value', () => {
    const wiql = buildWiql({ where: [{ field: 'System.AssignedTo', op: '=', macro: '@Me' }] });
    expect(wiql).toBe('SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me');
  });

  it('includes ORDER BY when given, and a custom field list', () => {
    const wiql = buildWiql({
      fields: ['System.Id', 'System.Title'],
      where: [{ field: 'System.State', op: '=', value: 'Active' }],
      orderBy: '[System.ChangedDate] DESC',
    });
    expect(wiql).toBe(
      "SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.State] = 'Active' ORDER BY [System.ChangedDate] DESC"
    );
  });

  it('omits WHERE entirely when there are no clauses', () => {
    expect(buildWiql({ where: [] })).toBe('SELECT [System.Id] FROM WorkItems');
  });
});
