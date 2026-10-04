import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

/**
 * One-off: share access `{ anyone }` becomes `{ link, repo }`, and `discoverable` becomes `listed`.
 * Run with `convex run migrations:shareAccessV2` before deploying the schema that requires it.
 */
export const shareAccessV2 = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("shares").paginate({ cursor: cursor ?? null, numItems: 200 });
    for (const share of page.page) {
      const { _id, _creationTime, discoverable, listed, access, ...rest } = share as typeof share & {
        listed?: boolean;
        access: { anyone?: boolean; link?: boolean; repo?: boolean; users: string[]; orgs: string[]; teams: string[] };
      };
      await ctx.db.replace(_id, {
        ...rest,
        access: { link: access.link ?? access.anyone ?? false, users: access.users, orgs: access.orgs, teams: access.teams, repo: access.repo ?? false },
        listed: listed ?? discoverable ?? false,
      } as never);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.migrations.shareAccessV2, { cursor: page.continueCursor });
  },
});
