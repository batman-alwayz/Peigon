import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const api = import.meta.env.VITE_API_URL || '';
const prettySize = (n) => n < 1048576 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function Upload() {
  const [file, setFile] = useState(null), [message, setMessage] = useState(''), [url, setUrl] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); if (!file) return setMessage('Choose a file first.');
    setBusy(true); setMessage('Uploading securely…'); setUrl('');
    const data = new FormData(e.currentTarget); data.set('file', file);
    try { const response = await fetch(`${api}/api/shares`, { method: 'POST', body: data }); const result = await response.json(); if (!response.ok) throw Error(result.error); setUrl(result.url.replace(/^http:\/\/[^/]+/, api || location.origin)); setMessage('Share link created. Send it only to the intended recipient.'); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  return <section className="card"><h1>Send a file securely</h1><p>Files automatically disappear after the limits you choose.</p><form onSubmit={submit}><label className="drop"><input type="file" name="file" onChange={(e) => setFile(e.target.files[0])} required/><strong>{file ? `Selected: ${file.name}` : 'Choose a file or drag one here'}</strong><small>{file ? prettySize(file.size) : 'One file · maximum 100 MB'}</small></label><div className="grid"><label>Expires after<select name="expiryMinutes"><option value="10">10 minutes</option><option value="60">1 hour</option><option value="1440">24 hours</option></select></label><label>Download limit<select name="maxDownloads"><option value="1">1 download</option><option value="3">3 downloads</option><option value="10">10 downloads</option></select></label></div><label>Passkey <em>optional</em><input name="password" type="password" minLength="4" placeholder="At least 4 characters"/></label><button disabled={busy}>{busy ? 'Uploading…' : 'Upload & create link'}</button></form>{message && <p className={url ? 'success' : 'notice'}>{message}</p>}{url && <div className="link"><a href={url}>{url}</a><button type="button" onClick={() => navigator.clipboard.writeText(url)}>Copy</button></div>}</section>;
}
function Vault({ token }) {
  const [share, setShare] = useState(null), [passwordRequired, setPasswordRequired] = useState(false), [password, setPassword] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => { fetch(`${api}/api/shares/${token}`).then(async r => { const body = await r.json(); if (!r.ok) throw Error(body.error); setPasswordRequired(body.passwordRequired); setShare(body.share || null); }).catch(e => setError(e.message)).finally(() => setLoading(false)); }, [token]);
  async function unlock(e) { e.preventDefault(); const r = await fetch(`${api}/api/shares/${token}/unlock`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password}) }); const d=await r.json(); if(!r.ok) return setError(d.error); setShare(d.share); setPasswordRequired(false); setError(''); }
  async function download() { const r=await fetch(`${api}/api/shares/${token}/download`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})}); if(!r.ok){const d=await r.json();return setError(d.error)} const blob=await r.blob();const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=share.fileName;link.click();URL.revokeObjectURL(link.href); }
  if (loading) return <section className="card"><h1>Checking secure link…</h1></section>;
  if (error && !share) return <section className="card"><h1>File unavailable</h1><p className="notice">{error}</p></section>;
  return <section className="card"><h1>{share ? 'Your secure file is ready' : 'Unlock your file'}</h1>{!share && <p>Enter the passkey supplied by the sender.</p>}{passwordRequired && <form onSubmit={unlock}><label>Passkey<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required/></label><button>Unlock file</button></form>}{share && <><p className="metadata">{share.fileName}<br/>{prettySize(share.fileSize)} · {share.downloadsRemaining} download(s) left<br/>Expires {new Date(share.expiresAt).toLocaleString()}</p><button onClick={download}>Download file</button></>}{error && <p className="notice">{error}</p>}</section>;
}
function App(){ const match=location.pathname.match(/^\/vault\/([^/]+)$/); return <main><a className="brand" href="/">VaultDrop <span>secure temporary sharing</span></a>{match?<Vault token={match[1]}/>:<Upload/>}</main> }
createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);
