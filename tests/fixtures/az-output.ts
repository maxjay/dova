import type { AzTeam, AzTeamFieldValues, AzTeamIteration } from '../../src/lib/team-resolver.js';

/** `az devops team list --project MyProject` fixtures. */
export const oneTeam: AzTeam[] = [
  { id: 'team-1', name: 'MyTeam', url: 'https://dev.azure.com/contoso/_apis/projects/MyProject/teams/MyTeam' },
];

export const multipleTeams: AzTeam[] = [
  { id: 'team-1', name: 'MyTeam', url: 'https://dev.azure.com/contoso/_apis/projects/MyProject/teams/MyTeam' },
  { id: 'team-2', name: 'Website Team', url: 'https://dev.azure.com/contoso/_apis/projects/MyProject/teams/WebsiteTeam' },
];

/** `az boards area team list --team MyTeam` fixtures. */
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

/** `az boards iteration team list --team MyTeam --timeframe current` fixtures. */
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
