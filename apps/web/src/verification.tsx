import { useEffect, useState } from "react";
import { api, ApiError } from "./api";

export function VerificationNotice({
  email,
  initialMessage,
  initialCooldown,
  onSignIn,
}: {
  email: string;
  initialMessage: string;
  initialCooldown: number;
  onSignIn: () => void;
}) {
  const [address, setAddress] = useState(email);
  const [message, setMessage] = useState(initialMessage);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deadline, setDeadline] = useState(
    () => Date.now() + initialCooldown * 1000,
  );
  const [remaining, setRemaining] = useState(initialCooldown);
  useEffect(() => {
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  async function resend() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ message: string; retryAfter: number }>(
        "/auth/resend-verification",
        { email: address },
      );
      setMessage(result.message);
      setDeadline(Date.now() + result.retryAfter * 1000);
      setRemaining(result.retryAfter);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2>Check your email</h2>
      <p>
        Open the CargoCheck verification email and follow its link before
        signing in. Links expire after 30 minutes. Check your spam folder too.
      </p>
      <p role="status">{message}</p>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <label>
        Email
        <input
          type="email"
          autoComplete="email"
          required
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="btn primary"
        disabled={busy || remaining > 0 || !address.trim()}
        onClick={() => void resend()}
      >
        {busy
          ? "Requesting link…"
          : remaining > 0
            ? `Resend available in ${remaining}s`
            : "Resend verification link"}
      </button>
      <button type="button" className="auth-switch" onClick={onSignIn}>
        Back to sign in
      </button>
    </>
  );
}

type VerificationStatus =
  "ready" | "success" | "expired" | "invalid" | "already_used";
const copy: Record<VerificationStatus, { title: string; text: string }> = {
  ready: {
    title: "Verify your email",
    text: "Confirm your email ownership to access CargoCheck shipment reviews. Select Verify email to continue.",
  },
  success: {
    title: "Email verified",
    text: "Your email is verified. Sign in to access your shipment reviews.",
  },
  expired: {
    title: "This link has expired",
    text: "Verification links expire after 30 minutes. Request a new link from the sign-in screen.",
  },
  invalid: {
    title: "This link is invalid",
    text: "The link may be incomplete or replaced by a newer one. Use the latest email or request a new link.",
  },
  already_used: {
    title: "This link was already used",
    text: "This verification link has already been used. Sign in, or request a new link if your email still needs verification.",
  },
};
export function EmailVerificationPage() {
  const [token] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "",
  );
  const [status, setStatus] = useState<VerificationStatus>(() =>
    /^[a-f0-9]{64}$/.test(token) ? "ready" : "invalid",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // Remove the secret from the address bar/history before any interaction.
    window.history.replaceState(null, "", "/?verify-email");
  }, []);
  async function verify() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        status: Exclude<VerificationStatus, "ready">;
      }>("/auth/verify-email", { token });
      setStatus(result.status);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) setStatus("invalid");
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      <section className="auth-story">
        <div className="brand">
          <span className="mark">
            <img src="/favicon.svg" width="36" height="36" alt="" />
          </span>
          CargoCheck AI
        </div>
        <div>
          <h1>
            Verify your email.
            <br />
            Start your review.
          </h1>
          <p>
            Confirm ownership of your email before accessing shipment documents.
          </p>
        </div>
      </section>
      <section className="auth-form">
        <div className="verification-panel">
          <h2>{copy[status].title}</h2>
          <p role="status">{copy[status].text}</p>
          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
          {status === "ready" && (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void verify()}
            >
              {busy ? "Verifying…" : "Verify email"}
            </button>
          )}
          <a className="btn" href="/?sign-in">
            {status === "success" || status === "already_used"
              ? "Sign in"
              : "Go to sign in"}
          </a>
        </div>
      </section>
    </div>
  );
}
