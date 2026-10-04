import { type SessionEvent, describeAccess } from "@opticon/core";
import { api } from "@opticon/server/api";
import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import {
  type Account,
  type AutosyncState,
  type MyShare,
  type SharePreview,
  createShare,
  deleteShare,
  disableAutosync,
  enableAutosync,
  fetchAutosync,
  fetchSharePreview,
  unshare,
} from "./api";
import { isPrivate, useAccessEditor } from "../AccessEditor";
import { Transcript } from "../Transcript";

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
  "url-secret": "login or secret URL parameters",
  "encoded-secret": "encoded sensitive values",
  "login-code": "login codes",
  "bearer-token": "bearer tokens",
  "secret-assignment": "secret-looking values",
  "high-entropy": "random-looking strings",
  "private-host": "private hostnames",
  "private-address": "private network addresses",
  email: "email addresses",
};

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
  const [autosync, setAutosync] = useState<AutosyncState>();
  const { access, empty: restrictedToNobody, editor } = useAccessEditor(share?.access);
  // Off by default: listing is a separate, deliberate choice from sharing.
  const [listed, setListed] = useState(share?.listed ?? false);
  const policy = useQuery(api.instance.policy, {});
  const autosyncAccess = policy ? describeAccess(policy.defaultAccess).toLowerCase() : "the default access";

  useEffect(() => {
    dialog.current?.showModal();
    fetchSharePreview(props.sessionKey).then(setPreview, (e: Error) => setError(e.message));
    // Sessions without a working directory can't be matched to a project; leave the option out.
    fetchAutosync(props.sessionKey).then(setAutosync, () => {});
  }, [props.sessionKey]);

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
  const privateShare = share && isPrivate(share.access);

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
              <p>
                <strong>Title:</strong> {preview.meta.title ?? "(untitled)"}
                {preview.meta.project && <><br /><strong>Project:</strong> {preview.meta.project}</>}
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

        {canShare && editor}

        {canShare && (
          <div className="listing">
            <label className="toggle">
              <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />
              List on my profile, the repo page, and the feed
            </label>
            <span className="hint">Only people who can open it see it there, but they won't need the link.</span>
          </div>
        )}

        {canShare && autosync && (
          <div className="autosync">
            <label className="toggle">
              <input
                type="checkbox"
                checked={!!autosync.rule}
                disabled={busy}
                onChange={(e) => {
                  const project = autosync.rule?.repo ?? autosync.rule?.path ?? autosync.target;
                  if (!e.target.checked) return void run(async () => setAutosync(await disableAutosync(props.sessionKey)));
                  if (confirm(`This will sync all of your sessions in ${project} and list them for ${autosyncAccess}. Continue?`)) {
                    void run(async () => setAutosync(await enableAutosync(props.sessionKey)));
                  }
                }}
              />
              Autosync every session in <code>{autosync.rule ? (autosync.rule.repo ?? autosync.rule.path) : autosync.target}</code>
            </label>
            <p className="hint">
              Shared with {autosyncAccess} and listed on your profile
              {autosyncRepo(autosync.rule?.repo ?? autosync.target) && (
                <>, and on the repo's page once GitHub confirms you can push to it</>
              )}
              . Sessions active from now on upload about every 30 seconds, redacted but without this preview.
            </p>
          </div>
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
            {!privateShare && (
              <button
                type="button"
                className="button"
                disabled={busy}
                title="Only you can open it. The copy stays on the server and keeps syncing."
                onClick={() => run(() => unshare(share.shareId).then(() => dialog.current?.close()))}
              >
                Unshare
              </button>
            )}
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => {
                if (confirm("Delete the copy on the server? The link stops working, and auto sync won't upload this session again.")) {
                  void run(() => deleteShare(share.shareId).then(() => dialog.current?.close()));
                }
              }}
            >
              Delete
            </button>
            <button type="button" className="button primary" disabled={busy || restrictedToNobody} onClick={() => run(() => createShare(props.sessionKey, access, listed))}>
              {busy ? "Saving…" : "Save & resync"}
            </button>
          </>
        ) : (
          <>
            <span className="hint">
              {account.liveSync ? (
                "Live sync is on: viewers see new messages as they happen."
              ) : (
                <>
                  Live sync is off: viewers see this snapshot. Turn it on with <code>opticon live-sync on</code>.
                </>
              )}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="button primary"
              disabled={busy || !preview || restrictedToNobody}
              onClick={() => run(() => createShare(props.sessionKey, access, listed))}
            >
              {busy ? "Sharing…" : "Create share link"}
            </button>
          </>
        )}
      </footer>
    </dialog>
  );
}

/** `owner/name` when an autosync target is a GitHub repo, which gets a repo page. */
function autosyncRepo(target: string | undefined): string | undefined {
  return target?.startsWith("github.com/") ? target.slice("github.com/".length) : undefined;
}
