import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("recheck repo access", { hours: 1 }, internal.repos.recheck, {});
crons.interval("recheck org membership", { minutes: 15 }, internal.access.recheckMembers, {});

export default crons;
