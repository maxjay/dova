/* ------------------------------------------------------------------ *
 * What dova works with. Azure DevOps' REST shapes are mapped into these
 * once, in ado/map.ts; nothing else sees a raw REST object.
 * ------------------------------------------------------------------ */

/** Where a command is pointed: an organization, usually a project, often a repo and branch. */
export interface Scope {
  org: string;
  /** `https://dev.azure.com/{org}` */
  orgUrl: string;
  project: string;
  repo?: string;
  branch?: string;
}

export interface WorkItemRef {
  id: number;
  title: string | null;
  type: string | null;
  state: string | null;
}

/** One labelled section of a work item's content: description, acceptance criteria, repro steps. */
export interface BodySection {
  label: string;
  text: string;
}

export interface WorkItem extends WorkItemRef {
  project: string | null;
  assignedTo: string | null;
  areaPath: string | null;
  iterationPath: string | null;
  parentId: number | null;
  /** Plain text, HTML stripped, only the sections the item actually has. */
  body: BodySection[];
  url: string;
}

export interface PullRequest {
  id: number;
  title: string;
  /** active | completed | abandoned */
  status: string;
  isDraft: boolean;
  author: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  project: string;
  repo: string;
  url: string;
}

export interface ThreadLocation {
  file: string;
  /** 1-based; the PR's version of the file when it has the line, else the base's. */
  line: number;
}

export interface Comment {
  id: number;
  author: string | null;
  publishedAt: string | null;
  text: string;
  /** text | codeChange | system */
  kind: string;
}

export interface Thread {
  id: number;
  /** active | fixed | wontFix | closed | pending | unknown */
  status: string;
  unresolved: boolean;
  /** Null for a general comment not anchored to a file. */
  location: ThreadLocation | null;
  comments: Comment[];
}

export type ThreadStatus = 'active' | 'fixed' | 'wontFix' | 'closed' | 'pending';

export interface Run {
  id: number;
  name: string;
  /** notStarted | inProgress | completed | cancelling | postponed */
  status: string;
  /** succeeded | partiallySucceeded | failed | canceled; null while running */
  result: string | null;
  queuedAt: string | null;
  sourceBranch: string | null;
  url: string;
}

export interface TimelineRecord {
  id: string;
  parentId: string | null;
  /** Stage | Phase | Job | Task | Checkpoint */
  type: string;
  name: string;
  result: string | null;
  startTime: string | null;
  logId: number | null;
}

export interface WorkItemState {
  name: string;
  /** Proposed | InProgress | Resolved | Completed | Removed — process-agnostic. */
  category: string;
}

export interface TeamAreas {
  /** The team's default area path; empty when none is flagged. */
  defaultArea: string;
  areas: string[];
}
