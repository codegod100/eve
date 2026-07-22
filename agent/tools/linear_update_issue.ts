import { defineTool } from "eve/tools";
import { z } from "zod";
import { hasLinearApiKey, updateEveIssue } from "../lib/linear.js";

export default defineTool({
  description:
    "Update a Linear issue only if it belongs to the eve project. " +
    "Change title, description, priority, state (name or type), or assignee. " +
    "Pass assignee empty string to unassign. Requires LINEAR_API_KEY.",
  inputSchema: z.object({
    id: z
      .string()
      .min(1)
      .describe("Issue identifier (TEAM-123) or UUID."),
    title: z.string().optional().describe("New title."),
    description: z.string().optional().describe("New markdown description."),
    priority: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe("0=none, 1=urgent, 2=high, 3=normal, 4=low."),
    state: z
      .string()
      .optional()
      .describe('New state name or type, e.g. "Done", "completed", "In Progress".'),
    assignee: z
      .string()
      .nullable()
      .optional()
      .describe('Assignee name/email/"me", or empty/null to unassign.'),
  }),
  outputSchema: z.object({
    project: z.string(),
    issue: z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string(),
      url: z.string(),
      state: z.string(),
      priorityLabel: z.string(),
      assignee: z.string().nullable(),
    }),
  }),
  async execute({ id, title, description, priority, state, assignee }) {
    if (!hasLinearApiKey()) {
      throw new Error(
        "LINEAR_API_KEY missing — inject from OpenBao via scripts/start.sh.",
      );
    }

    const { project, issue } = await updateEveIssue({
      id,
      title,
      description,
      priority,
      state,
      assignee:
        assignee === undefined
          ? undefined
          : assignee === null || assignee === ""
            ? null
            : assignee,
    });

    return {
      project: project.name,
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state: issue.state.name,
        priorityLabel: issue.priorityLabel,
        assignee: issue.assignee?.name ?? null,
      },
    };
  },
});
