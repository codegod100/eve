import { defineTool } from "eve/tools";
import { z } from "zod";
import { createEveIssue, hasLinearApiKey } from "../lib/linear.js";

export default defineTool({
  description:
    "Create a Linear issue always attached to the eve project (cannot target " +
    "other projects). Title required; optional description, priority (0–4), " +
    "state name/type, assignee (name/email/me). Requires LINEAR_API_KEY. " +
    "Never echo the key.",
  inputSchema: z.object({
    title: z.string().min(1).describe("Issue title."),
    description: z
      .string()
      .optional()
      .describe("Markdown description body."),
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
      .describe('Workflow state name or type, e.g. "Todo", "started".'),
    assignee: z
      .string()
      .optional()
      .describe('Assignee name, email, or "me".'),
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
  async execute({ title, description, priority, state, assignee }) {
    if (!hasLinearApiKey()) {
      throw new Error(
        "LINEAR_API_KEY missing — inject from OpenBao via scripts/start.sh.",
      );
    }

    const { project, issue } = await createEveIssue({
      title,
      description,
      priority,
      state,
      assignee,
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
