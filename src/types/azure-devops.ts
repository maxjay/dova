/**
 * Minimal shapes for the Azure DevOps REST objects dova reads. These are
 * intentionally partial — only the fields dova actually uses — since the
 * real objects carry many more fields we don't care about. Field names
 * are the wire (camelCase) names.
 */

export interface AzIdentityRef {
  displayName: string;
  uniqueName?: string;
  id?: string;
}

/** GitPullRequest, from `_apis/git/.../pullrequests`. */
export interface AzPullRequest {
  pullRequestId: number;
  title: string;
  /** "active" | "abandoned" | "completed" | "notSet" */
  status: string;
  isDraft?: boolean;
  description?: string;
  createdBy: AzIdentityRef;
  creationDate: string;
  sourceRefName: string;
  targetRefName: string;
  repository?: { id: string; name: string; project?: { id: string; name: string } };
  url: string;
}

/**
 * WorkItem, from `_apis/wit/workitems` and `_apis/wit/workitemsbatch`.
 * Fields are keyed by their process reference name (e.g. "System.Title"),
 * never hardcoded beyond the System.* fields that exist on every process
 * template.
 */
export interface AzWorkItem {
  id: number;
  url: string;
  fields: {
    'System.Title'?: string;
    'System.State'?: string;
    'System.WorkItemType'?: string;
    'System.AssignedTo'?: AzIdentityRef;
    'System.TeamProject'?: string;
    'System.Parent'?: number;
    [field: string]: unknown;
  };
}

/**
 * Build (Azure Pipelines runs are "Build" objects under the REST API's
 * `_apis/build/builds` namespace).
 */
export interface AzBuild {
  id: number;
  buildNumber: string;
  /** "notStarted" | "inProgress" | "completed" | "cancelling" | "postponed" */
  status: string;
  /** "succeeded" | "partiallySucceeded" | "failed" | "canceled" | null while running */
  result: string | null;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  sourceBranch?: string;
  definition?: { id: number; name: string };
  _links?: { web?: { href: string } };
  url: string;
}

/** A thread's position in a file — CommentPosition, from the git API models. Line numbers are 1-based. */
export interface AzCommentPosition {
  line: number;
  offset?: number;
}

/**
 * CommentThreadContext — present only on a thread anchored to a specific
 * line of a file (a code-review comment); absent on a general top-level
 * PR comment. `right*` is the PR's proposed version of the file, `left*`
 * the base version (used for a comment on a line only the base side has,
 * e.g. one that got deleted).
 */
export interface AzCommentThreadContext {
  filePath: string;
  rightFileStart?: AzCommentPosition;
  rightFileEnd?: AzCommentPosition;
  leftFileStart?: AzCommentPosition;
  leftFileEnd?: AzCommentPosition;
}

/** GitPullRequestCommentThread, from the PR threads endpoint. */
export interface AzCommentThread {
  id: number;
  /** "active" | "fixed" | "wontFix" | "closed" | "pending" | "unknown" */
  status: string;
  isDeleted?: boolean;
  comments: AzComment[];
  publishedDate?: string;
  /** null/absent for a general PR comment not anchored to any file. */
  threadContext?: AzCommentThreadContext | null;
}

export interface AzComment {
  id: number;
  content?: string;
  author?: AzIdentityRef;
  publishedDate?: string;
  /** "text" | "codeChange" | "system" — system comments ("X created the PR") aren't real discussion. */
  commentType?: string;
}

/** GitRepository — only used for its `defaultBranch` (e.g. "refs/heads/main"). */
export interface AzGitRepository {
  id: string;
  name: string;
  defaultBranch?: string;
}
