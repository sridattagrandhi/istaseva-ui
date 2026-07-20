"""Self-contained HTML upload UI served at GET /. No external CDNs (works offline)."""

INDEX_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>IstaSeva · Image Moderation</title>
<style>
  :root{
    --bg:#0f1216; --card:#171b22; --line:#272d38; --txt:#e7ecf3; --muted:#9aa6b6;
    --green:#1fae5a; --amber:#e0a526; --red:#e0483d; --accent:#3b82f6;
  }
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--txt)}
  .wrap{max-width:760px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:22px;margin:0 0 2px} .sub{color:var(--muted);margin:0 0 22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}
  .drop{border:2px dashed var(--line);border-radius:12px;padding:34px 18px;text-align:center;
        cursor:pointer;transition:.15s;color:var(--muted)}
  .drop:hover{border-color:var(--accent)}
  .drop.drag{border-color:var(--accent);background:#172033;color:var(--txt)}
  .drop b{color:var(--txt)}
  #preview{max-width:100%;max-height:280px;border-radius:10px;margin-top:14px;display:none}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px}
  button{font:inherit;border-radius:9px;border:1px solid var(--accent);background:var(--accent);color:#fff;font-weight:600;padding:9px 14px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .hint{font-size:12px;color:var(--muted);margin-top:6px}
  .verdict{display:flex;align-items:center;gap:14px;margin-bottom:14px}
  .badge{font-weight:800;letter-spacing:.5px;padding:10px 16px;border-radius:10px;font-size:18px}
  .allow{background:rgba(31,174,90,.15);color:var(--green);border:1px solid var(--green)}
  .review{background:rgba(224,165,38,.15);color:var(--amber);border:1px solid var(--amber)}
  .block{background:rgba(224,72,61,.15);color:var(--red);border:1px solid var(--red)}
  .err{background:rgba(224,72,61,.12);color:var(--red);border:1px solid var(--red);padding:12px;border-radius:10px}
  .bar{height:10px;border-radius:6px;background:#0f1320;overflow:hidden;border:1px solid var(--line)}
  .bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--green),var(--amber),var(--red))}
  .kv{display:grid;grid-template-columns:150px 1fr;gap:6px 14px;margin-top:14px;font-size:14px}
  .kv div:nth-child(odd){color:var(--muted)}
  .chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
  .chip{background:#0f1320;border:1px solid var(--line);border-radius:20px;padding:3px 11px;font-size:12px}
  .muted{color:var(--muted)}
  .spin{display:inline-block;width:15px;height:15px;border:2px solid #fff5;border-top-color:#fff;border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px}
  @keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
  <h1>IstaSeva · Image Moderation</h1>
  <p class="sub">Upload a listing photo to check it for explicit content before it goes live.</p>

  <div class="card">
    <div id="drop" class="drop">
      <b>Click to choose</b> or drop an image here<br/>
      <span class="hint">JPEG / PNG / WEBP</span>
      <img id="preview" alt="preview"/>
    </div>
    <input id="file" type="file" accept="image/*" hidden/>
    <div class="row">
      <button id="go" disabled>Check image</button>
    </div>
  </div>

  <div id="result" class="card" style="display:none"></div>
</div>

<script>
const $ = s => document.querySelector(s);
const file = $('#file'), drop = $('#drop'), preview = $('#preview'), go = $('#go'), result = $('#result');
let chosen = null;

drop.addEventListener('click', ()=> file.click());
file.addEventListener('change', e=> setFile(e.target.files[0]));
['dragover','dragenter'].forEach(ev=> drop.addEventListener(ev, e=>{e.preventDefault();drop.classList.add('drag')}));
['dragleave','drop'].forEach(ev=> drop.addEventListener(ev, e=>{e.preventDefault();drop.classList.remove('drag')}));
drop.addEventListener('drop', e=> setFile(e.dataTransfer.files[0]));

function setFile(f){
  if(!f) return;
  chosen = f;
  preview.src = URL.createObjectURL(f);
  preview.style.display='block';
  go.disabled=false;
}

go.addEventListener('click', async ()=>{
  if(!chosen) return;
  go.disabled=true; const label=go.textContent; go.innerHTML='<span class="spin"></span> Checking…';
  result.style.display='block'; result.innerHTML='<span class="muted">Running the model (first run downloads it once)…</span>';
  try{
    const fd=new FormData(); fd.append('file', chosen);
    const res=await fetch('/moderate',{method:'POST',body:fd});
    const data=await res.json();
    if(!res.ok || data.error){ render_error(data.error || ('HTTP '+res.status)); }
    else render(data);
  }catch(err){ render_error(err.message); }
  go.disabled=false; go.textContent=label;
});

function render_error(msg){ result.innerHTML='<div class="err"><b>Error:</b> '+escape(msg)+'</div>'; }

function render(d){
  const v=(d.verdict||'?').toLowerCase();
  const s=d.scores||{};
  const nsfw=(s.nsfw??0);
  const dets=(s.nsfw_detections||[]).map(x=>`${x.class} (${(x.score*100|0)}%)`);
  const reasons=(d.reasons||[]).map(r=>`<span class="chip">${escape(r)}</span>`).join('');
  result.innerHTML=`
    <div class="verdict">
      <span class="badge ${v}">${(d.verdict||'?').toUpperCase()}</span>
      <span class="muted">${reasons||''}</span>
    </div>
    <div class="muted" style="font-size:13px">Explicit-content score</div>
    <div class="bar"><i style="width:${Math.round(nsfw*100)}%"></i></div>
    <div class="kv">
      <div>NSFW score</div><div>${nsfw.toFixed(3)}</div>
      ${dets.length?`<div>Detections</div><div>${escape(dets.join(', '))}</div>`:''}
      <div>Model</div><div>${escape((d.models&&d.models.nsfw)||'?')}</div>
      <div>Time</div><div>${d.elapsed_ms??'?'} ms</div>
    </div>`;
}
function escape(x){return String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
</script>
</body>
</html>
"""
