import { api } from "@opticon/server/api";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { SignInButton } from "./main";
import { type HostedConfig, useSessionToken } from "./session";

/** Second half of `opticon login`: the user confirms the code shown in their terminal. */
export function CliApprove({ code }: { code: string; config: HostedConfig }) {
  const token = useSessionToken();
  const login = useQuery(api.auth.cliLogin, { token, userCode: code });
  const approve = useMutation(api.auth.approveCliLogin);
  const [error, setError] = useState<string>();

  return (
    <main className="hosted-page narrow center">
      {!login ? (
        <p className="hint">Loading…</p>
      ) : login.status === "expired" ? (
        <>
          <h2>This login request expired</h2>
          <p className="dim">
            Run <code>opticon login</code> again.
          </p>
        </>
      ) : login.status === "approved" ? (
        <>
          <h2>You're signed in</h2>
          <p className="dim">Return to your terminal. You can close this tab.</p>
        </>
      ) : (
        <>
          <h2>Sign in to the Opticon CLI</h2>
          <p className="dim">
            Confirm that <strong>{login.label}</strong> is showing this code:
          </p>
          <p className="user-code">{code}</p>
          {login.signedIn && token ? (
            <button
              type="button"
              className="button primary"
              onClick={() => approve({ token, userCode: code }).catch((e: Error) => setError(e.message))}
            >
              Approve
            </button>
          ) : (
            <SignInButton primary />
          )}
          {error && <p className="notice error">{error}</p>}
        </>
      )}
    </main>
  );
}
