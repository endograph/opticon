import type { SessionEvent, ShareAccess } from "@opticon/core";
import { useEffect, useRef, useState } from "react";
import { type Account, type MyShare, type SharePreview, createShare, deleteShare, fetchSharePreview } from "./api";
import { Transcript } from "./Transcript";

const RULE_LABELS: Record<string, string> = {
  "private-key": "private keys",
  "anthropic-key": "Anthropic API keys",
  "openai-key": "OpenAI API keys",
  "github-token": "GitHub tokens",
  "aws-access-key": "AWS access keys",
  "google-api-key": "Google API keys",
  "slack-token": "Slack tokens",
  "stripe-key": "Stripe keys",
  "npm-token": "npm tokens",
  jwt: "JWTs",
  "url-credentials": "credentials in URLs",
  "bearer-token": "bearer tokens",
  "secret-assignment": "secret-looking values",
  "high-entropy": "random-looking strings",
};

const list = (values: string[]) => values.join(", ");
const parse = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/**
 * Shows exactly what sharing uploads (after projection and redaction), lets the owner choose who
 * can open it, and manages an existing share.
 */
export function ShareDialog(props: { sessionKey: string; share?: MyShare; account?: Account; onClose: () => void }) {
  const { share, account } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<SharePreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [anyone, setAnyone] = useState(share?.access.anyone ?? true);
  const [users, setUsers] = useState(list(share?.access.users ?? []));
  const [orgs, setOrgs] = useState(list(share?.access.orgs ?? []));
  const [teams, setTeams] = useState(list(share?.access.teams ?? []));

  useEffect(() => {
    dialog.current?.showModal();
    fetchSharePreview(props.sessionKey).then(setPreview, (e: Error) => setError(e.message));
  }, [props.sessionKey]);

  const access: ShareAccess = anyone
    ? { anyone: true, users: [], orgs: [], teams: [] }
    : { anyone: false, users: parse(users), orgs: parse(orgs), teams: parse(teams) };
  const restrictedToNobody = !anyone && !access.users.length && !access.orgs.length && !access.teams.length;

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const messages = preview?.events.filter((e) => e.kind === "message").length ?? 0;
  const tools = preview?.events.filter((e) => e.kind === "tool").length ?? 0;
  const redacted = preview?.findings.reduce((n, f) => n + f.count, 0) ?? 0;
  const canShare = account?.configured && account.signedIn;

  return (
    <dialog ref={dialog} className="share-dialog" onClose={props.onClose}>
      <header>
        <h2>{share ? "Shared session" : "Share this session"}</h2>
        <button type="button" className="button subtle" onClick={() => dialog.current?.close()} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="share-body">
        <section className="share-summary">
          {!preview && !error && <p className="hint">Preparing preview…</p>}
          {preview && (
            <>
              <p>
                Sharing uploads a copy of <strong>{messages} messages</strong> and <strong>{tools} tool steps</strong>. Tool
                inputs, tool outputs, and thinking stay on this machine.
              </p>
              <div className="warning">
                {redacted > 0 ? (
                  <>
                    <strong>
                      {redacted} item{redacted === 1 ? "" : "s"} redacted:
                    </strong>{" "}
                    {preview.findings.map((f) => `${f.count} ${RULE_LABELS[f.rule] ?? f.rule}`).join(", ")}.{" "}
                  </>
                ) : (
                  "Nothing was redacted automatically. "
                )}
                Redaction is best effort, so read the preview before sharing.
              </div>
            </>
          )}
        </section>

        {preview && (
          <div className="share-preview">
            <Transcript events={preview.events as SessionEvent[]} status="ready" />
          </div>
        )}

        {canShare && (
          <section className="share-access">
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
                <p className="hint">
                  Org and team access only works for orgs that allow Opticon. Org admins may need to approve it first.
                </p>
              </div>
            )}
          </section>
        )}
      </div>

      {error && <p className="notice error">{error}</p>}

      <footer>
        {!account?.configured ? (
          <span className="hint">Sharing isn't configured in this build.</span>
        ) : !account.signedIn ? (
          <span className="hint">
            {account.error ?? "Sign in to share:"} run <code>opticon login</code> in a terminal.
          </span>
        ) : share ? (
          <>
            <div className="share-link">
              <input readOnly value={share.url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
              <button
                type="button"
                className="button"
                onClick={() => {
                  void navigator.clipboard.writeText(share.url);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <span className="spacer" />
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => {
                if (confirm("Stop sharing? The copy on the server is deleted and the link stops working.")) {
                  void run(() => deleteShare(share.shareId).then(() => dialog.current?.close()));
                }
              }}
            >
              Stop sharing
            </button>
            <button type="button" className="button primary" disabled={busy || restrictedToNobody} onClick={() => run(() => createShare(props.sessionKey, access))}>
              {busy ? "Saving…" : "Save & resync"}
            </button>
          </>
        ) : (
          <>
            <span className="hint">
              {account.liveSync ? "Live sync is on: viewers see new messages as they happen." : "Live sync is off: viewers see this snapshot."}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="button primary"
              disabled={busy || !preview || restrictedToNobody}
              onClick={() => run(() => createShare(props.sessionKey, access))}
            >
              {busy ? "Sharing…" : "Create share link"}
            </button>
          </>
        )}
      </footer>
    </dialog>
  );
}
