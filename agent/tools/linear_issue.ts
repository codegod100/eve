import { defineTool } from "eve/tools";
import { z } from "zod";
import { getEveIssue, hasLinearApiKey } from "../lib/linear.js";

export default defineTool({
  description:
    "Get one Linear issue by identifier (e.g. EVE-12) or UUID. " +
    "Only issues on the eve project are returned; others are rejected. " +
    "Use after linear_issues or linear_status. Requires LINEAR_API_KEY.",
  inputSchema: z.object({
    id: z
      .string()
      .min(1)
      .describe(
        "Issue identifier (TEAM-123) or UUID from linear_issues / Linear UI.",
      ),
  }),
  outputSchema: z.object({
    project: z.string(),
    issue: z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      url: z.string(),
      priority: z.number(),
      priorityLabel: z.string(),
      state: z.string(),
      stateType: z.string(),
      assignee: z.string().nullable(),
      labels: z.array(z.string()),
      createdAt: z.string(),
      updatedAt: z.string(),
      completedAt: z.string().nullable(),
      dueDate: z.string().nullable(),
    }),
  }),
  async execute({ id }) {
    if (!hasLinearApiKey()) {
      throw new Error(
        "LINEAR_API_KEY missing — inject from OpenBao via scripts/start.sh.",
      );
    }

    const { project, issue } = await getEveIssue(id);
    return {
      project: project.name,
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        priority: issue.priority,
        priorityLabel: issue.priorityLabel,
        state: issue.state.name,
        stateType: issue.state.type,
        assignee: issue.assignee?.name ?? null,
        labels: issue.labels,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        completedAt: issue.completedAt,
        dueDate: issue.dueDate,
      },
    };
  },
});
