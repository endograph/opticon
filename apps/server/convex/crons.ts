import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("recheck repo access", { hours: 1 }, internal.repos.recheck, {});

export default crons;
