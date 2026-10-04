import { PRIVATE_ACCESS, type ShareAccess } from "@opticon/core";
import { api } from "@opticon/server/api";
import { useQuery } from "convex/react";
import { type ReactNode, useState } from "react";

export { describeAccess, isPrivate } from "@opticon/core";

const list = (values: string[]) => values.join(", ");
const parse = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/**
 * Who can open a share, beyond its owner. The options add up, and only those this instance
 * allows are offered. A new share starts from the instance's default access.
 */
export function useAccessEditor(initial?: ShareAccess): { access: ShareAccess; empty: boolean; editor: ReactNode } {
  const policy = useQuery(api.instance.policy, {});
  const start = initial ?? policy?.defaultAccess ?? PRIVATE_ACCESS;
  // Until a new share's default arrives, nothing has been chosen yet.
  const [chosen, setChosen] = useState<{ link: boolean; repo: boolean; people: boolean }>();
  const [users, setUsers] = useState(list(initial?.users ?? []));
  const [orgs, setOrgs] = useState(list(initial?.orgs ?? []));
  const [teams, setTeams] = useState(list(initial?.teams ?? []));

  const picked = chosen ?? { link: start.link, repo: start.repo, people: !!(start.users.length || start.orgs.length || start.teams.length) };
  const set = (change: Partial<typeof picked>) => setChosen({ ...picked, ...change });
  const allows = (grant: "link" | "people" | "repo") => !policy || policy.grants.includes(grant);
  const access: ShareAccess = {
    link: picked.link,
    repo: picked.repo,
    users: picked.people ? parse(users) : [],
    orgs: picked.people ? parse(orgs) : [],
    teams: picked.people ? parse(teams) : [],
  };
  const empty = !access.link && !access.repo && !access.users.length && !access.orgs.length && !access.teams.length;
  const signIn = policy?.allowedOrgs.length ? `members of ${policy.allowedOrgs.join(", ")} who sign in` : "viewers sign in with GitHub";

  const editor = (
    <div className="share-access">
      {allows("link") && (
        <label className="radio">
          <input type="checkbox" checked={picked.link} onChange={(e) => set({ link: e.target.checked })} />
          <span>
            <strong>Anyone with the link</strong>
            <span className="dim"> · {policy?.anonymous === false ? signIn : "no sign-in needed"}</span>
          </span>
        </label>
      )}
      {allows("repo") && (
        <label className="radio">
          <input type="checkbox" checked={picked.repo} onChange={(e) => set({ repo: e.target.checked })} />
          <span>
            <strong>People who can read the repo</strong>
            <span className="dim"> · as GitHub says, once the session's repo is confirmed</span>
          </span>
        </label>
      )}
      {allows("people") && (
        <label className="radio">
          <input type="checkbox" checked={picked.people} onChange={(e) => set({ people: e.target.checked })} />
          <span>
            <strong>People I choose</strong>
            <span className="dim"> · {signIn}</span>
          </span>
        </label>
      )}
      {allows("people") && picked.people && (
        <div className="access-fields">
          <label>
            People
            <input value={users} onChange={(e) => setUsers(e.target.value)} placeholder="octocat, hubot" />
          </label>
          <label>
            Organizations
            <input value={orgs} onChange={(e) => setOrgs(e.target.value)} placeholder="acme" />
          </label>
          <label>
            Teams
            <input value={teams} onChange={(e) => setTeams(e.target.value)} placeholder="acme/platform" />
          </label>
          <p className="hint">Org and team access only works for orgs that allow Opticon. Org admins may need to approve it first.</p>
        </div>
      )}
    </div>
  );

  return { access, empty, editor };
}
