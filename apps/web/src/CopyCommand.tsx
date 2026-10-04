import { useState } from "react";

/** A one-line snippet with a copy button. `prompt` marks it as a shell command. */
export function CopyCommand({ command, prompt = true }: { command: string; prompt?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code>
        {prompt && <span className="prompt">$ </span>}
        {command}
      </code>
      <button
        type="button"
        className="button subtle small"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
