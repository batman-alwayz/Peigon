import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { zipSync } from "fflate";
import {
  ArrowUpRight,
  Check,
  Clock3,
  Copy,
  Download,
  File,
  FileKey2,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
  Zap,
} from "lucide-react";
import "./style.css";

const api = import.meta.env.VITE_API_URL || "";
const MAX_BYTES = 100 * 1024 * 1024;
const ENCRYPTION_OVERHEAD = 28;
const get = (route) => `${api}${route}`;
const size = (n) =>
  n < 1048576 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const Brand = () => (
  <a className="brand" href="/">
    <b>
      <Zap size={16} fill="currentColor" />
    </b>
    Peigon
  </a>
);

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function fromBase64Url(value) {
  const binary = atob(
    value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
async function importTransferKey(raw) {
  return crypto.subtle.importKey("raw", fromBase64Url(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes),
  );
  const result = new Uint8Array(iv.length + encrypted.length);
  result.set(iv);
  result.set(encrypted, iv.length);
  return result;
}
async function decryptBytes(key, bytes) {
  if (bytes.length < ENCRYPTION_OVERHEAD)
    throw new Error("This file is incomplete or damaged.");
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12) },
    key,
    bytes.subarray(12),
  );
}
function safeZipName(name) {
  const flattened = name
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("_");
  const withoutControls = [...flattened]
    .filter((character) => character.charCodeAt(0) >= 0x20)
    .join("");
  return withoutControls.replace(/[<>:"|?*]/g, "_").slice(0, 180) || "file";
}
function safeDisplayName(name) {
  const leaf = name.replace(/\\/g, "/").split("/").pop() || "download";
  const cleaned = [...leaf]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  return cleaned || "download";
}

function UploadPage() {
  const [files, setFiles] = useState([]),
    [drag, setDrag] = useState(false),
    [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0),
    [uploadBytes, setUploadBytes] = useState(0),
    [message, setMessage] = useState(""),
    [link, setLink] = useState(""),
    [copied, setCopied] = useState(false);
  const picker = useRef(null);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const choose = (list) => {
    const picked = Array.from(list || []);
    if (!picked.length) return;
    if (
      picked.reduce((sum, file) => sum + file.size, 0) >
      MAX_BYTES - ENCRYPTION_OVERHEAD
    ) {
      setMessage("The selected files exceed the 100 MB total limit.");
      return;
    }
    setFiles(picked);
    setLink("");
    setMessage("");
  };
  async function submit(event) {
    event.preventDefault();
    if (!files.length) {
      setMessage("Choose at least one file first.");
      return;
    }
    const form = event.currentTarget;
    setBusy(true);
    setProgress(0);
    setMessage("Preparing encrypted transfer…");
    setLink("");
    try {
      let plainBytes;
      let displayName;
      if (files.length === 1) {
        plainBytes = new Uint8Array(await files[0].arrayBuffer());
        displayName = safeDisplayName(files[0].name);
      } else {
        const entries = {};
        const usedNames = new Set();
        for (const file of files) {
          const base = safeZipName(file.name);
          let name = base;
          let suffix = 2;
          while (usedNames.has(name))
            name = `${base.replace(/(\.[^.]+)?$/, "")} (${suffix++})${base.match(/\.[^.]+$/)?.[0] || ""}`;
          usedNames.add(name);
          entries[name] = new Uint8Array(await file.arrayBuffer());
        }
        plainBytes = zipSync(entries, { level: 1 });
        displayName = `${files.length} files.zip`;
      }
      if (plainBytes.length + ENCRYPTION_OVERHEAD > MAX_BYTES)
        throw new Error(
          "The prepared file exceeds the 100 MB upload limit. Try fewer or smaller files.",
        );
      const rawKey = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey(
        "raw",
        rawKey,
        "AES-GCM",
        false,
        ["encrypt"],
      );
      const encryptedPayload = await encryptBytes(key, plainBytes);
      const encryptedName = toBase64Url(
        await encryptBytes(key, new TextEncoder().encode(displayName)),
      );
      setUploadBytes(encryptedPayload.length);
      const data = new FormData(form);
      data.delete("file");
      data.set(
        "file",
        new Blob([encryptedPayload], { type: "application/octet-stream" }),
        "encrypted-transfer.bin",
      );
      data.set("encryptedName", encryptedName);
      setMessage(
        `Encrypting complete · uploading ${size(encryptedPayload.length)}`,
      );
      const xhr = new XMLHttpRequest();
      xhr.open("POST", get("/api/shares"));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          setProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        setBusy(false);
        try {
          const result = JSON.parse(xhr.responseText);
          if (xhr.status < 200 || xhr.status > 299)
            throw new Error(result.error || "Upload failed.");
          const url = new URL(result.url);
          url.origin = location.origin;
          url.hash = toBase64Url(rawKey);
          setLink(url.toString());
          setProgress(100);
          setMessage("Your encrypted private link is ready to share.");
        } catch (error) {
          setMessage(error.message || "Upload failed.");
        }
      };
      xhr.onerror = () => {
        setBusy(false);
        setMessage("Network error. Please try again.");
      };
      xhr.send(data);
    } catch (error) {
      setBusy(false);
      setMessage(error.message || "Could not prepare this transfer.");
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setMessage(
        "Copy was blocked by the browser. Select and copy the link manually.",
      );
    }
  };
  return (
    <div className="layout">
      <section className="intro">
        <span className="eyebrow">
          <Sparkles size={14} /> PRIVATE TRANSFER, BEAUTIFULLY SIMPLE
        </span>
        <h1>
          Files that
          <br />
          <i>fade away.</i>
        </h1>
        <p>
          Send sensitive files with a passkey, a timer and a strict download
          limit. No accounts. No clutter.
        </p>
        <div className="trust">
          <span>
            <ShieldCheck size={17} /> Encrypted links
          </span>
          <span>
            <Clock3 size={17} /> Auto expiry
          </span>
        </div>
      </section>
      <section className="card">
        <div className="card-title">
          <div>
            <span className="step">01 / CREATE TRANSFER</span>
            <h2>Drop in your files</h2>
          </div>
          <LockKeyhole size={18} />
        </div>
        <form onSubmit={submit}>
          <div
            className={`drop ${drag ? "drag" : ""} ${files.length ? "has-file" : ""}`}
            onClick={() => picker.current?.click()}
            onDragEnter={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              choose(e.dataTransfer.files);
            }}
          >
            <input
              ref={picker}
              type="file"
              multiple
              onChange={(e) => choose(e.target.files)}
            />
            {files.length ? (
              <>
                <b className="file-icon">
                  <File size={21} />
                </b>
                <div>
                  <strong>
                    {files.length === 1
                      ? files[0].name
                      : `${files.length} files · ZIP archive`}
                  </strong>
                  <small>{size(total)} · Ready to encrypt</small>
                </div>
                <button
                  className="remove"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFiles([]);
                    setLink("");
                  }}
                >
                  <X size={16} />
                </button>
              </>
            ) : (
              <>
                <b className="upload-icon">
                  <Upload size={22} />
                </b>
                <div>
                  <strong>Drop files here</strong>
                  <small>or click to browse · 100 MB total maximum</small>
                </div>
              </>
            )}
          </div>
          <div className="options">
            <label>
              <span>
                <Clock3 size={15} /> Self-destruct after
              </span>
              <select name="expiryMinutes">
                <option value="10">10 minutes</option>
                <option value="60">1 hour</option>
                <option value="1440">24 hours</option>
              </select>
            </label>
            <label>
              <span>
                <Download size={15} /> Maximum downloads
              </span>
              <select name="maxDownloads">
                <option value="1">One download</option>
                <option value="3">Three downloads</option>
                <option value="10">Ten downloads</option>
              </select>
            </label>
          </div>
          <label className="password">
            <span>
              <FileKey2 size={15} /> Add a passkey <em>Optional</em>
            </span>
            <input
              name="password"
              type="password"
              minLength="4"
              maxLength="128"
              placeholder="At least 4 characters"
            />
          </label>
          {busy && (
            <div className="progress">
              <div>
                <span>
                  Uploading encrypted file ·{" "}
                  {size(Math.floor((uploadBytes * progress) / 100))} /{" "}
                  {size(uploadBytes)}
                </span>
                <b>{progress}%</b>
              </div>
              <i>
                <b style={{ width: `${progress}%` }} />
              </i>
            </div>
          )}
          <button className="primary" disabled={busy}>
            {busy ? (
              "Creating secure link…"
            ) : (
              <>
                Create private link <ArrowUpRight size={18} />
              </>
            )}
          </button>
        </form>
        {message && (
          <p className={link ? "success" : "notice"}>
            {link && <Check size={17} />} {message}
          </p>
        )}
        {link && (
          <div className="link">
            <span>{link}</span>
            <button type="button" onClick={copy}>
              {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        <p className="privacy">
          <LockKeyhole size={13} /> The encryption key stays in the link
          fragment, never on the server.
        </p>
      </section>
    </div>
  );
}

function Vault({ token }) {
  const [share, setShare] = useState(null),
    [locked, setLocked] = useState(false),
    [password, setPassword] = useState("");
  const [ticket, setTicket] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [submitting, setSubmitting] = useState(false),
    [downloading, setDownloading] = useState(false),
    [keyReady, setKeyReady] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [fileName, setFileName] = useState("");
  const rawKey = location.hash.slice(1);
  useEffect(() => {
    let active = true;
    fetch(get(`/api/shares/${token}`))
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (!active) return;
        setLocked(data.passwordRequired);
        if (data.passwordRequired) {
          setShare(null);
          setLoading(false);
          return;
        }
        const unlocked = await fetch(get(`/api/shares/${token}/unlock`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "" }),
        });
        const result = await unlocked.json();
        if (!unlocked.ok) throw new Error(result.error);
        if (active) {
          setShare(result.share);
          setTicket(result.ticket);
        }
      })
      .catch((err) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    async function readName() {
      if (!share) return;
      try {
        if (share.encryptedName && rawKey) {
          const key = await importTransferKey(rawKey);
          const encrypted = fromBase64Url(share.encryptedName);
          const plaintext = await decryptBytes(key, encrypted);
          if (active) {
            setFileName(new TextDecoder().decode(plaintext));
            setKeyReady(true);
          }
        } else if (active && !share.encryptedName) {
          setFileName(share.fileName || "Shared file");
          setKeyReady(true);
        } else if (active) setError("This link is missing its decryption key.");
      } catch {
        if (active)
          setError(
            "This link is missing its decryption key or has been changed.",
          );
      }
    }
    readName();
    return () => {
      active = false;
    };
  }, [share, rawKey]);
  async function unlock(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(get(`/api/shares/${token}/unlock`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setShare(result.share);
      setTicket(result.ticket);
      setLocked(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }
  async function download() {
    setDownloading(true);
    setError("");
    try {
      const response = await fetch(get(`/api/shares/${token}/download`), {
        method: "POST",
        headers: { Authorization: `Bearer ${ticket}` },
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error);
      }
      const encrypted = new Uint8Array(await response.arrayBuffer());
      let content = encrypted;
      if (share.encryptedName) {
        if (!rawKey)
          throw new Error("This link is missing its decryption key.");
        content = new Uint8Array(
          await decryptBytes(await importTransferKey(rawKey), encrypted),
        );
      }
      const blob = new Blob([content], { type: "application/octet-stream" });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = fileName || share.fileName || "download";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (err) {
      setError(err.message || "Download failed.");
    } finally {
      setDownloading(false);
    }
  }
  const remainingMs = share
    ? Math.max(0, new Date(share.expiresAt).getTime() - now)
    : 0;
  const remainingLabel = `${Math.floor(remainingMs / 3_600_000)}h ${Math.floor((remainingMs % 3_600_000) / 60_000)}m ${Math.floor((remainingMs % 60_000) / 1000)}s`;
  return (
    <section className="receiver">
      <span className="eyebrow">
        <ShieldCheck size={14} /> PROTECTED TRANSFER
      </span>
      <h1>
        {loading
          ? "Checking your link…"
          : share
            ? fileName || "Your file is ready."
            : "Unlock this file."}
      </h1>
      {error && <p className="notice">{error}</p>}
      {!loading && !share && (
        <form onSubmit={unlock}>
          <p>
            Enter the passkey supplied by the sender. The file name and contents
            remain encrypted until this link is opened in your browser.
          </p>
          <input
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            maxLength="128"
            placeholder="Enter passkey"
            required={locked}
          />
          <button className="primary" disabled={submitting}>
            {submitting ? (
              "Checking…"
            ) : (
              <>
                Unlock file <ArrowUpRight size={18} />
              </>
            )}
          </button>
        </form>
      )}
      {share && (
        <>
          <p className="vault-details">
            {size(
              Math.max(
                0,
                share.fileSize -
                  (share.encryptedName ? ENCRYPTION_OVERHEAD : 0),
              ),
            )}{" "}
            · {remainingLabel} remaining · {share.downloadsRemaining} download
            {share.downloadsRemaining === 1 ? "" : "s"} left
          </p>
          <div className="ready">
            <b className="file-icon">
              <File size={23} />
            </b>
            <div>
              <strong>{fileName || "Encrypted file"}</strong>
              <small>End-to-end encrypted</small>
            </div>
            <button
              className="primary"
              onClick={download}
              disabled={downloading || !ticket || !keyReady}
            >
              {downloading ? (
                "Decrypting…"
              ) : (
                <>
                  Download <Download size={17} />
                </>
              )}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function App() {
  const match = location.pathname.match(/^\/vault\/([^/]+)$/);
  return (
    <main>
      <header>
        <Brand />
        <span>
          <ShieldCheck size={15} /> End-to-end encrypted transfer
        </span>
      </header>
      {match ? <Vault token={match[1]} /> : <UploadPage />}
      <footer>
        Peigon · Temporary by design <b>•</b> Files expire automatically
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
