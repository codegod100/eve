import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  hasLinearApiKey,
  listEveIssues,
  type LinearStateType,
} from "../lib/linear.js";

const stateTypes = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
] as const;

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  priority: z.number(),
  priorityLabel: z.string(),
  state: z.string(),
  stateType: z.string(),
  assignee: z.string().nullable(),
  labels: z.array(z.string()),
  updatedAt: z.string(),
  dueDate: z.string().nullable(),
});

export default defineTool({
  description:
    "List Linear issues in the eve project only (scoped automatically). " +
    "Filter by free-text query, state name, state type, or assignee. " +
    "Default is open issues (not completed/canceled). Use linear_status for " +
    "counts/overview, linear_issue for one issue's full detail. " +
    "Requires LINEAR_API_KEY from OpenBao.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe("Search title/description (case-insensitive contains)."),
    state: z
      .string()
      .optional()
      .describe('Workflow state name, e.g. "In Progress", "Todo", "Done".'),
    state_type: z
      .enum(stateTypes)
      .optional()
      .describe(
        "State category: triage | backlog | unstarted | started | completed | canceled | duplicate.",
      ),
    assignee: z
      .string()
      .optional()
      .describe('Assignee name, email, or "me" for the API key owner.'),
    include_closed: z
      .boolean()
      .optional()
      .describe(
        "Include completed/canceled when no state filter is set. Default false.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max issues to return (1–100). Defaults to 25."),
  }),
  outputSchema: z.object({
    project: z.string(),
    projectUrl: z.string(),
    count: z.number(),
    issues: z.array(issueSchema),
  }),
  async execute({
    query,
    state,
    state_type,
    assignee,
    include_closed = false,
    limit = 25,
  }) {
    if (!hasLinearApiKey()) {
      throw new Error(
        "LINEAR_API_KEY missing — inject from OpenBao via scripts/start.sh.",
      );
    }

    const { project, issues, count } = await listEveIssues({
      query,
      state,
      stateType: state_type as LinearStateType | undefined,
      assignee,
      includeClosed: include_closed,
      limit,
    });

    return {
      project: project.name,
      projectUrl: project.url,
      count,
      issues: issues.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        url: i.url,
        priority: i.priority,
        priorityLabel: i.priorityLabel,
        state: i.state.name,
        stateType: i.state.type,
        assignee: i.assignee?.name ?? null,
        labels: i.labels,
        updatedAt: i.updatedAt,
        dueDate: i.dueDate,
      })),
    };
  },
});
