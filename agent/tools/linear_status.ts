import { defineTool } from "eve/tools";
import { z } from "zod";
import { eveProjectStatus, hasLinearApiKey } from "../lib/linear.js";

const issueBrief = z.object({
  identifier: z.string(),
  title: z.string(),
  state: z.string(),
  stateType: z.string(),
  priorityLabel: z.string(),
  assignee: z.string().nullable(),
  url: z.string(),
  updatedAt: z.string(),
});

export default defineTool({
  description:
    "Status overview of Linear items for the eve project only: progress, " +
    "counts by state (open/started/completed), and a sample of open issues. " +
    "Use when asked how the project is doing, what's open, or Linear status. " +
    "Requires LINEAR_API_KEY (OpenBao). Never returns the API key.",
  inputSchema: z.object({
    sample_limit: z
      .number()
      .int()
      .min(0)
      .max(50)
      .optional()
      .describe("How many open issues to sample (0–50). Defaults to 10."),
  }),
  outputSchema: z.object({
    configured: z.boolean(),
    project: z
      .object({
        id: z.string(),
        name: z.string(),
        state: z.string(),
        progress: z.number(),
        url: z.string(),
        targetDate: z.string().nullable(),
        startDate: z.string().nullable(),
        lead: z.string().nullable(),
        teams: z.array(z.string()),
      })
      .optional(),
    open: z.number().optional(),
    started: z.number().optional(),
    completed: z.number().optional(),
    canceled: z.number().optional(),
    total: z.number().optional(),
    byStateType: z.record(z.string(), z.number()).optional(),
    byStateName: z.record(z.string(), z.number()).optional(),
    sampleOpen: z.array(issueBrief).optional(),
    error: z.string().optional(),
    say: z.string().optional(),
  }),
  async execute({ sample_limit = 10 }) {
    if (!hasLinearApiKey()) {
      return {
        configured: false,
        error: "LINEAR_API_KEY missing",
        say:
          "Linear is not configured — LINEAR_API_KEY must come from OpenBao " +
          "(ai-api-keys) via scripts/start.sh.",
      };
    }

    const status = await eveProjectStatus(sample_limit);
    const p = status.project;
    return {
      configured: true,
      project: {
        id: p.id,
        name: p.name,
        state: p.state,
        progress: p.progress,
        url: p.url,
        targetDate: p.targetDate,
        startDate: p.startDate,
        lead: p.lead?.name ?? null,
        teams: p.teams.map((t) => `${t.key} (${t.name})`),
      },
      open: status.open,
      started: status.started,
      completed: status.completed,
      canceled: status.canceled,
      total: status.total,
      byStateType: status.byStateType,
      byStateName: status.byStateName,
      sampleOpen: status.sampleOpen.map((i) => ({
        identifier: i.identifier,
        title: i.title,
        state: i.state.name,
        stateType: i.state.type,
        priorityLabel: i.priorityLabel,
        assignee: i.assignee?.name ?? null,
        url: i.url,
        updatedAt: i.updatedAt,
      })),
      say:
        `Linear project "${p.name}": ${status.open} open, ${status.started} started, ` +
        `${status.completed} completed (of ${status.total} seen).`,
    };
  },
});
