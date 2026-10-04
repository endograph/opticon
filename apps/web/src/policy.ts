import { api } from "@opticon/server/api";
import { useQuery } from "convex/react";

/** The instance's limits and where its GitHub is. Undefined while loading. */
export const usePolicy = () => useQuery(api.instance.policy, {});

/** This instance's GitHub, e.g. https://github.com or a GitHub Enterprise Server. */
export const useGithubUrl = () => usePolicy()?.githubUrl ?? "https://github.com";
