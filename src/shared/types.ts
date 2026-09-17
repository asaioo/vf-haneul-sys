export type Role = 'viewer' | 'contributor' | 'developer';
export type Status = 'backlog' | 'ready' | 'in_progress' | 'review' | 'done';
export type Scope = 'read' | 'tasks:write' | 'links:write' | 'explanations:write';

export interface Member { id: string; login: string; role: Role; active: boolean; credentials?: string; access_checked: number; }
export interface Actor { id: string; role: Role; agent?: string; scopes: Scope[]; }

/**
 * A Project row is retained for repository identity and synchronization health.
 * In the GitHub-native mode, GitHub Issues and one Projects v2 project are the
 * authorities; the optional legacy fields are kept only to read old databases.
 */
export interface Project {
  repo_id: string;
  installation_id: string;
  full_name: string;
  url: string;
  integration_branch: string;
  prefix: string;
  sequence: number;
  confirmed: boolean;
  init: 'pending' | 'ready' | 'empty';
  last_sync: number;
  checkpoint: string | null;
  error: string | null;
  coverage_start: number;
  default_branch: string;
  gaps: string[];
  source_of_truth?: 'legacy' | 'github';
  project_node_id?: string | null;
  project_status_field_id?: string | null;
  project_status_field_name?: string | null;
  project_url?: string | null;
  legacy_data_warning?: string | null;
}

/** Legacy planning records are readable for backup/restore compatibility only. */
export interface Task {
  id: string;
  key: string;
  title: string;
  type: 'feature' | 'bug' | 'chore' | 'docs';
  description: string;
  owner: string | null;
  criteria: string[];
  paths: string[];
  planning_status: 'backlog' | 'ready';
  status: Status;
  suggested_status: Status;
  sync_mode: 'auto' | 'manual';
  attention_kind: 'blocked' | 'needs_clarification' | 'needs_human_review' | null;
  attention_reason: string | null;
  projection_reason: string | null;
  completion_pr_id: string | null;
  archived: boolean;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface Commit { sha: string; message: string; actor: string | null; url: string; }
export interface Change {
  id: string;
  identity: string;
  kind: 'pr' | 'branch' | 'direct_commit';
  number?: number;
  branch: string;
  incarnation?: string;
  head_sha: string;
  base_sha: string;
  merge_sha: string | null;
  base_ref: string;
  state: 'open' | 'closed' | 'merged' | 'deleted';
  draft: boolean;
  title: string;
  body: string;
  actor: string | null;
  url: string;
  commits: Commit[];
  files: string[];
  complete: boolean;
  integrity: string | null;
  canonical_id: string | null;
  version: number;
  observed_at: number;
}
export interface Link { change_id: string; task_id: string; state: 'confirmed' | 'disputed'; source: 'manual' | 'metadata'; actor: string; evidence: string[]; revision: string; superseded_reason: string | null; }
export interface Explanation { id: string; change_id: string; revision_sha: string; author: string; agent: string | null; summary: string; impact: string; validation: { source: 'contributor_report'; result: 'reported_passed' | 'reported_failed' | 'not_run'; details: string }; created_at: number; }
export interface ActionItem { id: string; kind: string; subject: string; recipient: string | null; revision: string; reason: string; state: 'open' | 'resolved' | 'dismissed'; resolution_reason: string | null; updated_at: number; }

/** A cached Issue returned by the selected repository's Issues REST endpoint. */
export interface GitHubIssue {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string | null;
  assignees: string[];
  labels: string[];
  url: string;
  updated_at: number;
  closed_at: number | null;
}

/** A cached Projects v2 item. Status is deliberately raw and may be null. */
export interface ProjectItem {
  id: string;
  project_node_id: string;
  content_type: 'Issue' | 'PullRequest' | 'DraftIssue' | 'Unknown';
  issue_id: string | null;
  issue_number: number | null;
  repo_id: string | null;
  status: string | null;
  status_field_id: string | null;
  updated_at: number;
}

export interface ProjectObservation {
  node_id: string;
  number: number | null;
  title: string;
  url: string;
  status_field_id: string;
  status_field_name: string;
  status_options: { id: string; name: string }[];
  items: ProjectItem[];
  fetched_at: number;
}

/** Durable state for the single app-owned coordination comment per PR. */
export interface GitHubComment {
  id: string;
  subject: string;
  change_id: string;
  marker: string;
  body: string;
  body_hash: string;
  comment_id: number | null;
  state: 'queued' | 'delivered' | 'blocked';
  attempts: number;
  error: string | null;
  updated_at: number;
}

export interface ContextSnapshot { sha: string; fetched_at: number; documents: Record<string, { blob_sha: string; content: string | null; missing: boolean; truncated: boolean }>; inventory: { path: string; type: string; sha: string }[]; manifests: string[]; scoped_policies: string[]; truncated: boolean; warnings: string[]; }
export interface SyncSnapshot {
  changes: Change[];
  branches: string[];
  context: ContextSnapshot | null;
  integration_sha: string | null;
  default_branch: string;
  full_name: string;
  url: string;
  empty: boolean;
  gaps: string[];
  issues?: GitHubIssue[];
  project?: ProjectObservation | null;
}
export interface Job { id: string; type: string; payload: string; state: 'queued' | 'running' | 'done' | 'failed'; attempts: number; next_at: number; lease_until: number; lease_token: string | null; error: string | null; created_at: number; }


export type GovernanceDecision = 'no_change' | 'fix_code' | 'update_rules';
export type GovernanceReviewKind = 'merged_policy' | 'issue' | 'pull_request';
export type GovernanceRequestState = 'queued' | 'running' | 'diagnostic' | 'not_configured' | 'result' | 'proposal';

/** A durable, immutable-identity governance request created by a signed GitHub event. */
export interface GovernanceRequest {
  id: string;
  /** GitHub delivery identity; distinct label events are deliberate re-requests. */
  delivery_id?: string;
  /** Defaults to merged_policy for rows created before edge review support. */
  kind?: GovernanceReviewKind;
  repo_id: string;
  installation_id: string;
  issue_id: string;
  issue_number: number;
  issue_body_hash: string;
  requester_id: string;
  requester_login: string;
  requester_type?: 'User' | 'Bot';
  pr_number: number;
  pr_id: string | null;
  state: GovernanceRequestState;
  decision: GovernanceDecision | null;
  rationale: string | null;
  proposed_agents_md: string | null;
  proposal_eligible: boolean;
  integration_sha: string | null;
  policy_sha: string | null;
  evidence_digest: string | null;
  branch: string | null;
  policy_commit_sha: string | null;
  proposal_number: number | null;
  proposal_url: string | null;
  comment_id: number | null;
  comment_body_hash: string | null;
  error: string | null;
  review_id?: number | null;
  model_attempts: number;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export interface GovernanceIssue {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  author_id: string | null;
  author_login: string | null;
  updated_at: number;
}

export interface GovernanceFileEvidence {
  path: string;
  status: string;
  patch: string | null;
  sha: string | null;
  omitted: boolean;
}

export interface GovernancePullRequestEvidence {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  base_ref: string;
  base_sha: string;
  head_sha: string;
  merge_sha: string | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  files: GovernanceFileEvidence[];
  commits: Commit[];
}

export interface GovernanceEvidence {
  repo_id: string;
  integration_sha: string;
  default_branch: string;
  policy: { sha: string; content: string | null; missing: boolean; truncated: boolean };
  /** Applicable directory-scoped AGENTS.md files at the pinned integration SHA. */
  scoped_policies?: { path: string; sha: string; content: string }[];
  pull_request: GovernancePullRequestEvidence;
  complete: boolean;
  warnings: string[];
}

export interface GovernancePermission {
  id: string | null;
  login: string;
  permission: string;
  can_write: boolean;
}

export interface GovernanceBranch {
  name: string;
  sha: string;
}

export interface GovernanceDiff {
  base_sha: string;
  head_sha: string;
  files: string[];
  complete: boolean;
  /** Re-fetched branch content and App-authorship proof for the exact proposal. */
  policy_content?: string | null;
  app_authored?: boolean;
}

export interface GovernancePullRequestResult {
  id: string;
  number: number;
  url: string;
  head: string;
  base: string;
  draft: boolean;
}
