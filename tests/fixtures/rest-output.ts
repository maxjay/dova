import type { AzTeam, AzTeamFieldValues, AzTeamIteration } from '../../src/lib/team-resolver.js';

/** `GET _apis/projects/MyProject/teams` fixtures — the `value` array of the response. */
export const oneTeam: AzTeam[] = [
  { id: 'team-1', name: 'MyTeam', url: 'https://dev.azure.com/contoso/_apis/projects/MyProject/teams/MyTeam' },
];

export const multipleTeams: AzTeam[] = [
  { id: 'team-1', name: 'MyTeam', url: 'https://dev.azure.com/contoso/_apis/projects/MyProject/teams/MyTeam' },
  { id: 'team-2', name: 'Website Team', url: 'https://dev.azure.com/contoso/_apis/projects/MyProject/teams/WebsiteTeam' },
];

/** `GET MyProject/MyTeam/_apis/work/teamsettings/teamfieldvalues` fixtures (one object, not a list). */
export const areaWithDefault: AzTeamFieldValues = {
  field: { referenceName: 'System.AreaPath', url: '' },
  defaultValue: 'MyProject\\MyTeam',
  values: [
    { value: 'MyProject\\MyTeam', includeChildren: false },
    { value: 'MyProject\\MyTeam\\Sub', includeChildren: true },
  ],
};

export const areaNoDefaultSingleValue: AzTeamFieldValues = {
  field: { referenceName: 'System.AreaPath', url: '' },
  defaultValue: '',
  values: [{ value: 'MyProject\\MyTeam', includeChildren: false }],
};

export const areaNoDefaultMultipleValues: AzTeamFieldValues = {
  field: { referenceName: 'System.AreaPath', url: '' },
  defaultValue: '',
  values: [
    { value: 'MyProject\\MyTeam', includeChildren: false },
    { value: 'MyProject\\MyTeam\\Sub', includeChildren: true },
  ],
};

/** `GET MyProject/MyTeam/_apis/work/teamsettings/iterations?$timeframe=current` fixtures — the `value` array of the response. */
export const currentIteration: AzTeamIteration[] = [
  {
    id: 'iter-1',
    name: 'Sprint 3',
    path: 'MyProject\\Sprint 3',
    attributes: { startDate: '2026-08-10T00:00:00Z', finishDate: '2026-08-24T00:00:00Z', timeFrame: 'current' },
    url: '',
  },
];

export const noCurrentIteration: AzTeamIteration[] = [];
