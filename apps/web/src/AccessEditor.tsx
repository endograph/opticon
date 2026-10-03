import type { ShareAccess } from "@opticon/core";
import { type ReactNode, useState } from "react";

const list = (values: string[]) => values.join(", ");
const parse = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** Who can open a share: anyone with the link, or chosen GitHub users, orgs, and teams. */
export function useAccessEditor(initial?: ShareAccess): { access: ShareAccess; empty: boolean; editor: ReactNode } {
  const [anyone, setAnyone] = useState(initial?.anyone ?? true);
  const [users, setUsers] = useState(list(initial?.users ?? []));
  const [orgs, setOrgs] = useState(list(initial?.orgs ?? []));
  const [teams, setTeams] = useState(list(initial?.teams ?? []));

  const access: ShareAccess = anyone
    ? { anyone: true, users: [], orgs: [], teams: [] }
    : { anyone: false, users: parse(users), orgs: parse(orgs), teams: parse(teams) };
  const empty = !anyone && !access.users.length && !access.orgs.length && !access.teams.length;

  const editor = (
    <div className="share-access">
      <label className="radio">
        <input type="radio" checked={anyone} onChange={() => setAnyone(true)} />
        <span>
          <strong>Anyone with the link</strong>
          <span className="dim"> · no sign-in needed</span>
        </span>
      </label>
      <label className="radio">
        <input type="radio" checked={!anyone} onChange={() => setAnyone(false)} />
        <span>
          <strong>Only people I choose</strong>
          <span className="dim"> · viewers sign in with GitHub</span>
        </span>
      </label>
      {!anyone && (
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

/** Only the owner can open it: unshared, or synced without sharing. */
export const isPrivate = (access: ShareAccess) =>
  !access.anyone && !access.users.length && !access.orgs.length && !access.teams.length;

/** "Anyone with the link", or "octocat, acme, acme/platform". */
export function describeAccess(access: ShareAccess): string {
  if (access.anyone) return "Anyone with the link";
  const who = [...access.users.map((u) => `@${u}`), ...access.orgs, ...access.teams];
  return who.length ? who.join(", ") : "Only you";
}
