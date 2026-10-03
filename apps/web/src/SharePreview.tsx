import type { SessionEvent } from "@opticon/core";
import { useEffect, useRef, useState } from "react";
import { type SharePreview, fetchSharePreview } from "./api";
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

/** Shows exactly what sharing would upload, after projection and redaction. */
export function SharePreviewDialog({ sessionKey, onClose }: { sessionKey: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<SharePreview>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    dialog.current?.showModal();
    fetchSharePreview(sessionKey).then(setPreview, (e: Error) => setError(e.message));
  }, [sessionKey]);

  const messages = preview?.events.filter((e) => e.kind === "message").length ?? 0;
  const tools = preview?.events.filter((e) => e.kind === "tool").length ?? 0;
  const redacted = preview?.findings.reduce((n, f) => n + f.count, 0) ?? 0;

  return (
    <dialog ref={dialog} className="share-dialog" onClose={onClose}>
      <header>
        <h2>Share this session</h2>
        <button type="button" className="button subtle" onClick={() => dialog.current?.close()} aria-label="Close">
          ✕
        </button>
      </header>
      {error && <p className="notice error">{error}</p>}
      {!preview && !error && <p className="hint pad">Preparing preview…</p>}
      {preview && (
        <>
          <div className="share-summary">
            <p>
              Sharing uploads a copy of <strong>{messages} messages</strong> and <strong>{tools} tool steps</strong>.
              Tool inputs, tool outputs, and thinking stay on this machine.
            </p>
            {redacted > 0 ? (
              <div className="warning">
                <strong>{redacted} item{redacted === 1 ? "" : "s"} redacted:</strong>{" "}
                {preview.findings.map((f) => `${f.count} ${RULE_LABELS[f.rule] ?? f.rule}`).join(", ")}.
                <br />
                Redaction is best effort. Read the preview below before sharing.
              </div>
            ) : (
              <div className="warning">
                Nothing was redacted automatically. Redaction is best effort, so read the preview below before sharing.
              </div>
            )}
          </div>
          <div className="share-preview">
            <Transcript events={preview.events as SessionEvent[]} status="ready" />
          </div>
          <footer>
            <span className="hint">Sharing needs <code>opticon login</code>, which isn't built yet.</span>
            <button type="button" className="button primary" disabled>
              Create share link
            </button>
          </footer>
        </>
      )}
    </dialog>
  );
}
