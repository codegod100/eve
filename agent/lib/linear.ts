/**
 * Linear GraphQL helpers for the eve agent.
 *
 * Auth: `LINEAR_API_KEY` from OpenBao (`ai-api-keys` via scripts/fetch-keys.sh).
 * Scope: every query/mutation is constrained to the configured Linear project
 * (default name "eve"; override with LINEAR_PROJECT_NAME or LINEAR_PROJECT_ID).
 *
 * Docs: https://linear.app/developers/graphql
 */

export const LINEAR_GQL = "https://api.linear.app/graphql";

/** Default Linear project name when LINEAR_PROJECT_ID is unset. */
export const DEFAULT_LINEAR_PROJECT_NAME = "eve";

export type LinearStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled"
  | "duplicate";

export type LinearIssueSummary = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  priorityLabel: string;
  state: { id: string; name: string; type: string };
  assignee: { id: string; name: string; email?: string } | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  dueDate: string | null;
  projectId: string | null;
  projectName: string | null;
};

export type LinearProject = {
  id: string;
  name: string;
  description: string | null;
  state: string;
  progress: number;
  url: string;
  targetDate: string | null;
  startDate: string | null;
  lead: { id: string; name: string } | null;
  teams: Array<{ id: string; name: string; key: string }>;
};

type GqlError = { message: string; path?: string[] };
type GqlResponse<T> = { data?: T; errors?: GqlError[] };

let projectCache: { key: string; project: LinearProject; at: number } | null =
  null;
const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000;

export function linearApiKey(): string | undefined {
  const key =
    process.env.LINEAR_API_KEY?.trim() ||
    process.env.LINEAR_ACCESS_TOKEN?.trim() ||
    process.env.LINEAR_API_TOKEN?.trim();
  return key || undefined;
}

export function hasLinearApiKey(): boolean {
  return Boolean(linearApiKey());
}

export function configuredProjectName(): string {
  return (
    process.env.LINEAR_PROJECT_NAME?.trim() || DEFAULT_LINEAR_PROJECT_NAME
  );
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 1:
      return "urgent";
    case 2:
      return "high";
    case 3:
      return "normal";
    case 4:
      return "low";
    default:
      return "none";
  }
}

function mapIssue(raw: {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  priority: number;
  state: { id: string; name: string; type: string };
  assignee?: { id: string; name: string; email?: string } | null;
  labels?: { nodes: Array<{ name: string }> };
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  dueDate?: string | null;
  project?: { id: string; name: string } | null;
}): LinearIssueSummary {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? null,
    url: raw.url,
    priority: raw.priority,
    priorityLabel: priorityLabel(raw.priority),
    state: raw.state,
    assignee: raw.assignee ?? null,
    labels: (raw.labels?.nodes ?? []).map((l) => l.name),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    completedAt: raw.completedAt ?? null,
    dueDate: raw.dueDate ?? null,
    projectId: raw.project?.id ?? null,
    projectName: raw.project?.name ?? null,
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  state { id name type }
  assignee { id name email }
  labels { nodes { name } }
  createdAt
  updatedAt
  completedAt
  dueDate
  project { id name }
`;

/**
 * Run a Linear GraphQL operation. Never logs the API key.
 */
export async function linearGql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs = 20_000,
): Promise<T> {
  const key = linearApiKey();
  if (!key) {
    throw new Error(
      "No LINEAR_API_KEY (OpenBao ai-api-keys). Set LINEAR_API_KEY or run scripts/start.sh with OpenBao.",
    );
  }

  const res = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: key,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let body: GqlResponse<T>;
  try {
    body = (await res.json()) as GqlResponse<T>;
  } catch {
    throw new Error(
      `Linear GraphQL non-JSON response (${res.status} ${res.statusText})`,
    );
  }

  if (!res.ok) {
    const msg =
      body.errors?.map((e) => e.message).join("; ") ||
      res.statusText ||
      "request failed";
    throw new Error(`Linear GraphQL HTTP ${res.status}: ${msg}`);
  }

  if (body.errors?.length) {
    throw new Error(
      `Linear GraphQL: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  if (body.data === undefined) {
    throw new Error("Linear GraphQL: empty data");
  }

  return body.data;
}

function mapProject(raw: {
  id: string;
  name: string;
  description?: string | null;
  state: string;
  progress: number;
  url: string;
  targetDate?: string | null;
  startDate?: string | null;
  lead?: { id: string; name: string } | null;
  teams?: { nodes: Array<{ id: string; name: string; key: string }> };
}): LinearProject {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? null,
    state: raw.state,
    progress: raw.progress,
    url: raw.url,
    targetDate: raw.targetDate ?? null,
    startDate: raw.startDate ?? null,
    lead: raw.lead ?? null,
    teams: raw.teams?.nodes ?? [],
  };
}

const PROJECT_FIELDS = `
  id
  name
  description
  state
  progress
  url
  targetDate
  startDate
  lead { id name }
  teams { nodes { id name key } }
`;

/**
 * Resolve the eve-scoped Linear project (cached briefly).
 * Prefer LINEAR_PROJECT_ID; else look up by LINEAR_PROJECT_NAME (default "eve").
 */
export async function resolveEveProject(
  force = false,
): Promise<LinearProject> {
  const projectId = process.env.LINEAR_PROJECT_ID?.trim();
  const name = configuredProjectName();
  const cacheKey = projectId ? `id:${projectId}` : `name:${name.toLowerCase()}`;

  if (
    !force &&
    projectCache &&
    projectCache.key === cacheKey &&
    Date.now() - projectCache.at < PROJECT_CACHE_TTL_MS
  ) {
    return projectCache.project;
  }

  let project: LinearProject;

  if (projectId) {
    const data = await linearGql<{
      project: Parameters<typeof mapProject>[0] | null;
    }>(
      `query ProjectById($id: String!) {
        project(id: $id) { ${PROJECT_FIELDS} }
      }`,
      { id: projectId },
    );
    if (!data.project) {
      throw new Error(
        `Linear project id ${projectId} not found (LINEAR_PROJECT_ID).`,
      );
    }
    project = mapProject(data.project);
  } else {
    const data = await linearGql<{
      projects: { nodes: Array<Parameters<typeof mapProject>[0]> };
    }>(
      `query ProjectByName($name: String!) {
        projects(filter: { name: { eqIgnoreCase: $name } }, first: 10) {
          nodes { ${PROJECT_FIELDS} }
        }
      }`,
      { name },
    );
    const nodes = data.projects.nodes;
    if (nodes.length === 0) {
      throw new Error(
        `No Linear project named "${name}". Set LINEAR_PROJECT_NAME or LINEAR_PROJECT_ID.`,
      );
    }
    // Prefer exact case-insensitive match; if several, take first non-completed.
    const preferred =
      nodes.find((n) => n.state !== "completed" && n.state !== "canceled") ??
      nodes[0];
    project = mapProject(preferred);
  }

  projectCache = { key: cacheKey, project, at: Date.now() };
  return project;
}

/** Build an IssueFilter that always includes the eve project id. */
export function eveProjectIssueFilter(
  projectId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extra,
    project: { id: { eq: projectId } },
  };
}

export type ListIssuesOpts = {
  /** Free-text search in title/description. */
  query?: string;
  /** Workflow state name (e.g. "In Progress"). */
  state?: string;
  /** State type: backlog | unstarted | started | completed | canceled | triage. */
  stateType?: LinearStateType;
  /** Assignee email, display name, or "me". */
  assignee?: string;
  /** Include completed/canceled (default false → open only). */
  includeClosed?: boolean;
  limit?: number;
};

export async function listEveIssues(
  opts: ListIssuesOpts = {},
): Promise<{ project: LinearProject; issues: LinearIssueSummary[]; count: number }> {
  const project = await resolveEveProject();
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);

  const filterParts: Record<string, unknown> = {};

  if (opts.query?.trim()) {
    filterParts.or = [
      { title: { containsIgnoreCase: opts.query.trim() } },
      { description: { containsIgnoreCase: opts.query.trim() } },
    ];
  }
  if (opts.state?.trim()) {
    filterParts.state = {
      ...(typeof filterParts.state === "object" && filterParts.state
        ? (filterParts.state as object)
        : {}),
      name: { eqIgnoreCase: opts.state.trim() },
    };
  }
  if (opts.stateType) {
    filterParts.state = {
      ...(typeof filterParts.state === "object" && filterParts.state
        ? (filterParts.state as object)
        : {}),
      type: { eq: opts.stateType },
    };
  }
  if (!opts.includeClosed && !opts.state && !opts.stateType) {
    filterParts.state = {
      ...(typeof filterParts.state === "object" && filterParts.state
        ? (filterParts.state as object)
        : {}),
      type: { nin: ["completed", "canceled", "duplicate"] },
    };
  }
  if (opts.assignee?.trim()) {
    const a = opts.assignee.trim();
    if (a.toLowerCase() === "me") {
      filterParts.assignee = { isMe: { eq: true } };
    } else if (a.includes("@")) {
      filterParts.assignee = { email: { eqIgnoreCase: a } };
    } else {
      filterParts.assignee = { name: { containsIgnoreCase: a } };
    }
  }

  const filter = eveProjectIssueFilter(project.id, filterParts);

  const data = await linearGql<{
    issues: {
      nodes: Array<Parameters<typeof mapIssue>[0]>;
    };
  }>(
    `query EveIssues($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) {
        nodes { ${ISSUE_FIELDS} }
      }
    }`,
    { filter, first: limit },
  );

  const issues = data.issues.nodes.map(mapIssue);
  return { project, issues, count: issues.length };
}

/**
 * Fetch one issue by UUID or identifier (e.g. EVE-12).
 * Rejects issues that are not on the eve project.
 */
export async function getEveIssue(
  idOrIdentifier: string,
): Promise<{ project: LinearProject; issue: LinearIssueSummary }> {
  const project = await resolveEveProject();
  const id = idOrIdentifier.trim();
  if (!id) throw new Error("Issue id or identifier is required");

  const data = await linearGql<{
    issue: Parameters<typeof mapIssue>[0] | null;
  }>(
    `query Issue($id: String!) {
      issue(id: $id) { ${ISSUE_FIELDS} }
    }`,
    { id },
  );

  if (!data.issue) {
    throw new Error(`Linear issue not found: ${id}`);
  }

  const issue = mapIssue(data.issue);
  if (issue.projectId !== project.id) {
    throw new Error(
      `Issue ${issue.identifier} is not in the "${project.name}" project ` +
        `(project=${issue.projectName ?? "none"}). All tools are scoped to that project.`,
    );
  }

  return { project, issue };
}

export type ProjectStatus = {
  project: LinearProject;
  byStateType: Record<string, number>;
  byStateName: Record<string, number>;
  open: number;
  started: number;
  completed: number;
  canceled: number;
  total: number;
  sampleOpen: LinearIssueSummary[];
};

/**
 * Aggregate status for the eve project: counts by state + sample of open issues.
 */
export async function eveProjectStatus(
  sampleLimit = 10,
): Promise<ProjectStatus> {
  const project = await resolveEveProject();

  // Pull a generous page for counts; Linear filter is project-scoped.
  const data = await linearGql<{
    issues: { nodes: Array<Parameters<typeof mapIssue>[0]> };
  }>(
    `query EveStatus($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) {
        nodes { ${ISSUE_FIELDS} }
      }
    }`,
    {
      filter: eveProjectIssueFilter(project.id),
      first: 250,
    },
  );

  const issues = data.issues.nodes.map(mapIssue);
  const byStateType: Record<string, number> = {};
  const byStateName: Record<string, number> = {};

  for (const issue of issues) {
    const t = issue.state.type || "unknown";
    const n = issue.state.name || "unknown";
    byStateType[t] = (byStateType[t] ?? 0) + 1;
    byStateName[n] = (byStateName[n] ?? 0) + 1;
  }

  const isOpen = (t: string) =>
    t !== "completed" && t !== "canceled" && t !== "duplicate";

  const sampleOpen = issues
    .filter((i) => isOpen(i.state.type))
    .slice(0, sampleLimit);

  return {
    project,
    byStateType,
    byStateName,
    open: issues.filter((i) => isOpen(i.state.type)).length,
    started: byStateType.started ?? 0,
    completed: byStateType.completed ?? 0,
    canceled: (byStateType.canceled ?? 0) + (byStateType.duplicate ?? 0),
    total: issues.length,
    sampleOpen,
  };
}

/** Team workflow states for the project's first team. */
export async function listProjectStates(): Promise<
  Array<{ id: string; name: string; type: string }>
> {
  const project = await resolveEveProject();
  const teamId = project.teams[0]?.id;
  if (!teamId) {
    throw new Error(
      `Project "${project.name}" has no teams; cannot list workflow states.`,
    );
  }

  const data = await linearGql<{
    team: {
      states: {
        nodes: Array<{ id: string; name: string; type: string }>;
      };
    } | null;
  }>(
    `query TeamStates($id: String!) {
      team(id: $id) {
        states {
          nodes { id name type }
        }
      }
    }`,
    { id: teamId },
  );

  return data.team?.states.nodes ?? [];
}

export type CreateIssueOpts = {
  title: string;
  description?: string;
  priority?: number;
  /** State name or type to set after create. */
  state?: string;
  assignee?: string;
  labelNames?: string[];
};

export async function createEveIssue(
  opts: CreateIssueOpts,
): Promise<{ project: LinearProject; issue: LinearIssueSummary }> {
  const project = await resolveEveProject();
  const teamId = project.teams[0]?.id;
  if (!teamId) {
    throw new Error(
      `Project "${project.name}" has no teams; cannot create issues.`,
    );
  }

  const title = opts.title.trim();
  if (!title) throw new Error("title is required");

  const input: Record<string, unknown> = {
    title,
    teamId,
    projectId: project.id,
  };
  if (opts.description !== undefined) input.description = opts.description;
  if (opts.priority !== undefined) input.priority = opts.priority;

  if (opts.state?.trim()) {
    const states = await listProjectStates();
    const want = opts.state.trim().toLowerCase();
    const match =
      states.find((s) => s.name.toLowerCase() === want) ??
      states.find((s) => s.type.toLowerCase() === want);
    if (!match) {
      throw new Error(
        `Unknown state "${opts.state}". Known: ${states.map((s) => s.name).join(", ")}`,
      );
    }
    input.stateId = match.id;
  }

  if (opts.assignee?.trim()) {
    const a = opts.assignee.trim();
    if (a.toLowerCase() === "me") {
      const me = await linearGql<{ viewer: { id: string } }>(
        `query { viewer { id } }`,
      );
      input.assigneeId = me.viewer.id;
    } else {
      const users = await linearGql<{
        users: { nodes: Array<{ id: string; name: string; email: string }> };
      }>(
        `query Users($filter: UserFilter) {
          users(filter: $filter, first: 5) {
            nodes { id name email }
          }
        }`,
        {
          filter: a.includes("@")
            ? { email: { eqIgnoreCase: a } }
            : { name: { containsIgnoreCase: a } },
        },
      );
      const u = users.users.nodes[0];
      if (!u) throw new Error(`No Linear user matching assignee "${a}"`);
      input.assigneeId = u.id;
    }
  }

  const data = await linearGql<{
    issueCreate: {
      success: boolean;
      issue: Parameters<typeof mapIssue>[0] | null;
    };
  }>(
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { ${ISSUE_FIELDS} }
      }
    }`,
    { input },
  );

  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error("Linear issueCreate failed");
  }

  return { project, issue: mapIssue(data.issueCreate.issue) };
}

export type UpdateIssueOpts = {
  id: string;
  title?: string;
  description?: string;
  priority?: number;
  state?: string;
  assignee?: string | null;
};

/**
 * Update an issue only if it belongs to the eve project.
 */
export async function updateEveIssue(
  opts: UpdateIssueOpts,
): Promise<{ project: LinearProject; issue: LinearIssueSummary }> {
  // Scope check first
  await getEveIssue(opts.id);

  const input: Record<string, unknown> = {};
  if (opts.title !== undefined) input.title = opts.title;
  if (opts.description !== undefined) input.description = opts.description;
  if (opts.priority !== undefined) input.priority = opts.priority;

  if (opts.state?.trim()) {
    const states = await listProjectStates();
    const want = opts.state.trim().toLowerCase();
    const match =
      states.find((s) => s.name.toLowerCase() === want) ??
      states.find((s) => s.type.toLowerCase() === want);
    if (!match) {
      throw new Error(
        `Unknown state "${opts.state}". Known: ${states.map((s) => s.name).join(", ")}`,
      );
    }
    input.stateId = match.id;
  }

  if (opts.assignee !== undefined) {
    if (opts.assignee === null || opts.assignee === "") {
      input.assigneeId = null;
    } else {
      const a = opts.assignee.trim();
      if (a.toLowerCase() === "me") {
        const me = await linearGql<{ viewer: { id: string } }>(
          `query { viewer { id } }`,
        );
        input.assigneeId = me.viewer.id;
      } else {
        const users = await linearGql<{
          users: { nodes: Array<{ id: string; name: string; email: string }> };
        }>(
          `query Users($filter: UserFilter) {
            users(filter: $filter, first: 5) {
              nodes { id name email }
            }
          }`,
          {
            filter: a.includes("@")
              ? { email: { eqIgnoreCase: a } }
              : { name: { containsIgnoreCase: a } },
          },
        );
        const u = users.users.nodes[0];
        if (!u) throw new Error(`No Linear user matching assignee "${a}"`);
        input.assigneeId = u.id;
      }
    }
  }

  if (Object.keys(input).length === 0) {
    throw new Error("No update fields provided");
  }

  const data = await linearGql<{
    issueUpdate: {
      success: boolean;
      issue: Parameters<typeof mapIssue>[0] | null;
    };
  }>(
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { ${ISSUE_FIELDS} }
      }
    }`,
    { id: opts.id.trim(), input },
  );

  if (!data.issueUpdate.success || !data.issueUpdate.issue) {
    throw new Error("Linear issueUpdate failed");
  }

  const project = await resolveEveProject();
  const issue = mapIssue(data.issueUpdate.issue);
  if (issue.projectId !== project.id) {
    throw new Error(
      `Refusing result outside project "${project.name}" (${issue.identifier}).`,
    );
  }

  return { project, issue };
}
