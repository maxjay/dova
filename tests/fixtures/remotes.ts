/**
 * Fabricated Azure Repos remote URLs covering every form dova's parser
 * needs to handle. Placeholders only — "contoso", "MyProject", "my-repo" —
 * never a real org.
 */
export const remotes = {
  httpsModern: 'https://dev.azure.com/contoso/MyProject/_git/my-repo',
  httpsModernWithUser: 'https://someuser@dev.azure.com/contoso/MyProject/_git/my-repo',
  httpsModernSpacedProject: 'https://dev.azure.com/contoso/My%20Project/_git/my-repo',
  httpsModernDotGit: 'https://dev.azure.com/contoso/MyProject/_git/my-repo.git',
  sshModern: 'git@ssh.dev.azure.com:v3/contoso/MyProject/my-repo',

  notAzureRepos: 'https://github.com/example/my-repo.git',
  malformed: 'not a url at all',
};

export const orgUrls = {
  modern: 'https://dev.azure.com/contoso',
};
