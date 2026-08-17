/**
 * The "Werkstatt" look: warm, dense, tool-like.
 *
 * Served inline rather than as files. There is no build step in this project
 * and no CDN is reachable from a page that must work offline, so one string is
 * both the simplest and the most robust option.
 */
export const CSS = `
*, *::before, *::after { box-sizing: border-box; }

:root {
  --bg:#1c1917; --panel:#242019; --sunk:#1a1714; --line:#3a332a;
  --ink:#f2ede4; --dim:#a89e8d;
  --accent:#d98032; --ok:#7fb069; --warn:#e0a33e; --bad:#d9614c;
  --radius:8px;
}

body {
  margin:0; background:var(--bg); color:var(--ink);
  font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color:var(--accent); }

/* --- sidebar ------------------------------------------------------------- */
/* Fixed rather than sticky: the nav must not scroll away on a long listing
   page, which is exactly where switching sections is most wanted. */
.side {
  position:fixed; inset:0 auto 0 0; width:14rem; z-index:20;
  background:var(--panel); border-right:1px solid var(--line);
  display:flex; flex-direction:column; gap:.35rem; padding:.9rem .75rem;
}
.side .brand { padding:.15rem .55rem .9rem; font-size:1.05rem; }
.nav-group { display:flex; flex-direction:column; gap:.15rem; }
/* Pushes settings to the bottom — a place you visit rarely reads as a footer. */
.nav-group.bottom { margin-top:auto; border-top:1px solid var(--line); padding-top:.6rem; }
.nav-item {
  display:flex; flex-direction:column; gap:.1rem;
  padding:.45rem .55rem; border-radius:6px; text-decoration:none;
  color:var(--dim); font-size:.88rem; border:1px solid transparent;
}
.nav-item:hover { background:var(--sunk); color:var(--ink); }
.nav-item.current { background:var(--sunk); color:var(--ink); border-color:var(--line); }
.nav-item.current span:first-child { color:var(--accent); font-weight:600; }
.nav-badge { font-size:.72rem; color:var(--dim); font-variant-numeric:tabular-nums; }

.shell { margin-left:14rem; }
@media (max-width:860px) {
  .side { position:static; width:auto; inset:auto; flex-direction:row; align-items:center; flex-wrap:wrap; }
  .side .brand { padding:0 .6rem 0 0; }
  .nav-group { flex-direction:row; }
  .nav-group.bottom { margin-top:0; border-top:none; padding-top:0; }
  .shell { margin-left:0; }
}

/* --- chrome ------------------------------------------------------------- */
.bar {
  display:flex; align-items:center; gap:1rem; padding:.85rem 1.25rem;
  background:var(--panel); border-bottom:1px solid var(--line);
  position:sticky; top:0; z-index:10;
}
.brand { font-weight:700; letter-spacing:.02em; text-decoration:none; color:var(--ink); }
.brand em { color:var(--accent); font-style:normal; }
.bar .ctx { color:var(--dim); font-size:.85rem; }
.env {
  margin-left:auto; font-size:.72rem; text-transform:uppercase; letter-spacing:.08em;
  color:var(--accent); border:1px solid var(--accent); border-radius:99px; padding:.15rem .6rem;
}
.env.prod { color:var(--bad); border-color:var(--bad); }

/* --- section headings and status table ---------------------------------- */
.section {
  font-size:.78rem; text-transform:uppercase; letter-spacing:.08em; color:var(--dim);
  font-weight:600; margin:1.4rem 0 .5rem; display:flex; align-items:center; gap:.5rem;
}
.section:first-child { margin-top:0; }
.section .count {
  background:var(--sunk); border:1px solid var(--line); border-radius:99px;
  padding:.05rem .45rem; font-size:.72rem; letter-spacing:0; color:var(--ink);
}
.pill.pending { border-color:var(--accent); color:var(--accent); }

.status { width:100%; border-collapse:collapse; font-size:.82rem; }
.status td { padding:.3rem .4rem .3rem 0; border-bottom:1px solid #2b251d; vertical-align:top; }
.status tr:last-child td { border-bottom:none; }
.st-mark { width:1.2rem; font-weight:700; text-align:center; }
.st-mark.ok { color:var(--ok); }
.st-mark.bad { color:var(--bad); }
.st-mark.info { color:var(--dim); }
.st-label { color:var(--dim); white-space:nowrap; padding-right:.7rem !important; }
.st-value { color:var(--ink); word-break:break-word; }
.st-value small { display:block; color:var(--dim); font-size:.74rem; margin-top:.1rem; }
.check-line { display:flex; gap:.5rem; align-items:center; color:var(--ink); }

main { max-width:1180px; margin:0 auto; padding:1.5rem; }
.split { display:grid; grid-template-columns:1.55fr 1fr; gap:1.5rem; align-items:start; }
@media (max-width:860px) { .split { grid-template-columns:1fr; } }

/* --- cards -------------------------------------------------------------- */
.card {
  background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  padding:1.1rem; margin-bottom:1.1rem;
}
h3 {
  font-size:.72rem; text-transform:uppercase; letter-spacing:.12em; color:var(--dim);
  margin:0 0 .7rem; font-weight:600;
}
h1 { font-size:1.25rem; margin:0 0 1rem; letter-spacing:-.01em; }

/* --- forms -------------------------------------------------------------- */
label { display:block; font-size:.78rem; color:var(--dim); margin-bottom:.3rem; }
.field, textarea, select {
  width:100%; background:var(--sunk); border:1px solid var(--line); border-radius:5px;
  color:var(--ink); padding:.55rem .7rem; font:inherit; font-size:.9rem;
}
textarea { min-height:8rem; resize:vertical; line-height:1.5; }
.field:focus, textarea:focus, select:focus { outline:2px solid var(--accent); outline-offset:-1px; }
.row { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:.75rem; }
.gap { height:.85rem; }

.counter { float:right; font-variant-numeric:tabular-nums; font-size:.75rem; color:var(--dim); }
.counter.tight { color:var(--warn); }
.counter.over { color:var(--bad); font-weight:700; }

/* --- tags --------------------------------------------------------------- */
.tags { display:flex; flex-wrap:wrap; gap:.35rem; margin-top:.55rem; }
.tag {
  background:#332c22; border:1px solid var(--line); border-radius:4px;
  padding:.15rem .45rem; font-size:.78rem; color:#dcd2c2;
}

/* --- images ------------------------------------------------------------- */
.imgs { display:grid; grid-template-columns:repeat(auto-fill,minmax(7rem,1fr)); gap:.5rem; }
.img {
  aspect-ratio:1; border-radius:5px; border:1px solid var(--line); overflow:hidden;
  background:var(--sunk); position:relative; display:grid; place-items:center;
}
.img img { width:100%; height:100%; object-fit:cover; display:block; }
.img.primary { border-color:var(--accent); border-width:2px; }
.img .n {
  position:absolute; top:3px; left:5px; font-size:.65rem; color:var(--accent);
  font-weight:700; background:rgba(28,25,23,.75); padding:0 .25rem; border-radius:3px;
}
.img .rm {
  position:absolute; top:3px; right:3px; background:rgba(28,25,23,.8); color:var(--bad);
  border:0; border-radius:3px; cursor:pointer; font-size:.75rem; padding:.05rem .3rem;
}
.drop {
  aspect-ratio:1; border:1px dashed var(--line); border-radius:5px; display:grid;
  place-items:center; color:var(--dim); font-size:.78rem; text-align:center; padding:.5rem;
  cursor:pointer;
}
.drop.over { border-color:var(--accent); color:var(--accent); }

/* Reference-only tiles: the designer's photos, which never become listing
   images. Held back visually so they cannot be mistaken for the row above —
   muted, dashed, and with no remove control, because there is nothing here to
   manage. */
.img.ref { border-style:dashed; opacity:.62; }
.img.ref:hover { opacity:1; }
.img.ref .n { color:var(--dim); }

.refbox { margin-top:1.1rem; padding-top:.9rem; border-top:1px solid var(--line); }
.refbox summary {
  cursor:pointer; font-size:.78rem; color:var(--dim); list-style:none;
}
.refbox summary::-webkit-details-marker { display:none; }
.refbox summary::before { content:"▸ "; color:var(--accent); }
.refbox[open] summary::before { content:"▾ "; }
.refbox summary:hover { color:var(--ink); }

/* --- locked channel ------------------------------------------------------ */
/* Dimmed rather than hidden: the copy is still worth reading and editing, the
   channel just cannot be published to. */
.card.locked { border-color:var(--bad); }
.card.locked h3 { color:var(--dim); }
.lockbar {
  background:#3a2622; border:1px solid var(--bad); border-radius:6px;
  padding:.5rem .6rem; font-size:.8rem; color:#f0d8d2; margin:.2rem 0 .8rem;
}

/* --- title options ------------------------------------------------------- */
.opts { display:flex; flex-direction:column; gap:.3rem; margin-top:.45rem; }
.opt {
  text-align:left; background:#2b251d; border:1px solid var(--line); border-radius:4px;
  padding:.35rem .5rem; font:inherit; font-size:.79rem; color:#dcd2c2; cursor:pointer;
}
.opt:hover { border-color:var(--accent); }
.opt.picked { border-color:var(--accent); color:var(--ink); }
.opt .len { color:var(--dim); font-variant-numeric:tabular-nums; margin-right:.4rem; }

/* --- price band ---------------------------------------------------------- */
.price { margin:.8rem 0 .4rem; }
.price h4 { font-size:.8rem; font-weight:600; margin:0 0 .45rem; }
.scale { position:relative; height:.5rem; background:#2b251d; border-radius:3px; }
/* The middle half of the market — where a price is unremarkable. */
.scale .mid { position:absolute; top:0; bottom:0; background:#3d4a33; border-radius:3px; }
.scale .tick { position:absolute; top:-.2rem; bottom:-.2rem; width:2px; margin-left:-1px; }
.scale .median { background:var(--dim); }
.scale .you { background:var(--accent); width:3px; margin-left:-1.5px; }
.scale .you.off { background:var(--warn); }
.scale-ends {
  display:flex; justify-content:space-between; font-size:.7rem; color:var(--dim);
  margin-top:.2rem; font-variant-numeric:tabular-nums;
}

/* --- pending rewrite ----------------------------------------------------- */
.warnbox { border-left:3px solid var(--accent); }
.diff { margin:.7rem 0; }
.diff h4 { font-size:.82rem; font-weight:600; margin:0 0 .3rem; }
.diff-old, .diff-new {
  font-size:.8rem; padding:.4rem .55rem; border-radius:4px; white-space:pre-wrap;
  word-break:break-word; border:1px solid var(--line);
}
/* Struck-through rather than red-on-green: the old text is not an error, it is
   simply the version being replaced. */
.diff-old { background:#2b251d; color:var(--dim); text-decoration:line-through; text-decoration-thickness:1px; }
.diff-new { background:#2a3326; color:var(--ink); margin-top:.25rem; }

/* --- keyword research --------------------------------------------------- */
.kw { width:100%; border-collapse:collapse; font-size:.79rem; margin-top:.35rem; }
.kw th {
  text-align:left; font-weight:600; color:var(--dim); font-size:.72rem;
  text-transform:uppercase; letter-spacing:.03em; padding:.2rem .4rem .2rem 0;
  border-bottom:1px solid var(--line);
}
.kw td { padding:.24rem .4rem .24rem 0; border-bottom:1px solid #2b251d; vertical-align:top; }
/* Figures line up for comparison; that is the entire point of the table. */
.kw td:not(:first-child) { text-align:right; font-variant-numeric:tabular-nums; color:var(--dim); white-space:nowrap; }
.kw tr:last-child td { border-bottom:none; }

/* --- checks ------------------------------------------------------------- */
.check { display:flex; gap:.55rem; padding:.4rem 0; font-size:.85rem; align-items:flex-start; }
.check .dot { flex:none; width:1.05rem; text-align:center; font-weight:700; }
.check.ok .dot { color:var(--ok); }
.check.warn .dot { color:var(--warn); }
.check.bad .dot { color:var(--bad); }
.check small { display:block; color:var(--dim); font-size:.78rem; margin-top:.1rem; }

/* --- buttons ------------------------------------------------------------ */
.btn {
  background:var(--accent); color:#1c1917; border:0; border-radius:5px; font-weight:650;
  padding:.6rem 1.1rem; font-size:.9rem; cursor:pointer; font-family:inherit;
}
.btn:hover { filter:brightness(1.08); }
.btn.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); font-weight:500; }
.btn.ghost:hover { border-color:var(--accent); filter:none; }
.btn[disabled] { opacity:.4; cursor:not-allowed; filter:none; }
.actions { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin-top:.6rem; }
.stack { display:flex; flex-direction:column; gap:.6rem; align-items:stretch; }
.note { font-size:.78rem; color:var(--dim); }

/* --- listing table ------------------------------------------------------ */
.list { width:100%; border-collapse:collapse; }
.list th {
  text-align:left; font-size:.72rem; text-transform:uppercase; letter-spacing:.1em;
  color:var(--dim); font-weight:600; padding:.5rem .6rem; border-bottom:1px solid var(--line);
}
.list td { padding:.7rem .6rem; border-bottom:1px solid var(--line); font-size:.9rem; vertical-align:top; }
.list tr:last-child td { border-bottom:0; }
.list a { text-decoration:none; font-weight:600; }
.pill {
  display:inline-block; font-size:.7rem; padding:.1rem .45rem; border-radius:99px;
  border:1px solid var(--line); color:var(--dim); white-space:nowrap;
}
.pill.published { color:var(--ok); border-color:var(--ok); }
.pill.failed { color:var(--bad); border-color:var(--bad); }

.banner { border-radius:var(--radius); padding:.7rem .9rem; margin-bottom:1.1rem; font-size:.88rem; }
.banner.bad { background:#3a201c; border:1px solid var(--bad); color:#f6d2cb; }
.banner.ok { background:#22301d; border:1px solid var(--ok); color:#dbeacf; }
.banner.warn { background:#332a19; border:1px solid var(--warn); color:#f0e0c2; }

.empty { text-align:center; padding:3rem 1rem; color:var(--dim); }

/* --- creation progress --------------------------------------------------- */
/* Indeterminate by design: the run waits on a language model, so there is no
   honest percentage to draw. A moving bar says "still working", which is the
   only claim that can be backed up. */
.bar-track {
  height:.45rem; background:var(--sunk); border:1px solid var(--line);
  border-radius:99px; overflow:hidden; margin-bottom:.7rem;
}
.bar-fill {
  height:100%; width:35%; border-radius:99px; background:var(--accent);
  animation:slide 1.5s ease-in-out infinite;
}
@keyframes slide {
  0%   { transform:translateX(-100%); }
  100% { transform:translateX(320%); }
}
/* Stopped and full: the work is over, and a bar still travelling would say
   otherwise. */
.bar-track.done .bar-fill { width:100%; animation:none; }
.bar-track.failed .bar-fill { width:100%; animation:none; background:var(--bad); }
@media (prefers-reduced-motion:reduce) {
  .bar-fill { animation:none; width:100%; opacity:.55; }
}

.plines {
  display:flex; flex-direction:column; gap:.15rem; margin:.9rem 0 .3rem;
  font-size:.84rem; max-height:22rem; overflow-y:auto;
}
.pl { padding:.12rem 0; }
.pl.step { color:var(--ink); font-weight:600; margin-top:.45rem; }
.pl.step::before { content:"› "; color:var(--accent); }
.pl.info { color:var(--ink); }
.pl.detail { color:var(--dim); font-size:.79rem; }
.pl.warn { color:var(--warn); }
.pl.ok { color:var(--ok); }
.pl.ok::before { content:"✓ "; }
`

/**
 * The only client-side script: live character counts, drag-and-drop uploading,
 * and a confirm on the two buttons that spend money.
 *
 * No framework and no build. The counters mirror the limits the server
 * enforces — they are a convenience, never the check itself.
 */
export const JS = `
// Live character counters. The limit lives in data-limit so the markup and the
// server rule stay visibly in step.
for (const input of document.querySelectorAll('[data-limit]')) {
  const limit = Number(input.dataset.limit);
  const out = document.getElementById(input.dataset.counter);
  if (!out) continue;
  const paint = () => {
    const n = input.value.length;
    out.textContent = n + ' / ' + limit;
    out.className = 'counter' + (n > limit ? ' over' : n > limit - 3 ? ' tight' : '');
  };
  input.addEventListener('input', paint);
  paint();
}

// Title options: click one to load it into the field. It is not saved until the
// form is submitted, so a pick can still be edited or abandoned.
for (const option of document.querySelectorAll('[data-fills]')) {
  option.addEventListener('click', () => {
    const input = document.getElementById(option.dataset.fills);
    if (!input) return;
    input.value = option.dataset.title;
    // Nudge the character counter, which listens for real typing.
    input.dispatchEvent(new Event('input'));
    input.focus();
    for (const sib of option.parentElement.querySelectorAll('[data-fills]')) {
      sib.classList.toggle('picked', sib === option);
    }
  });
}

// Drag-and-drop onto the upload tile.
const drop = document.querySelector('.drop');
if (drop) {
  const input = document.getElementById('image-input');
  drop.addEventListener('click', () => input && input.click());
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  }
  drop.addEventListener('drop', (e) => {
    if (!input || !e.dataTransfer?.files?.length) return;
    input.files = e.dataTransfer.files;
    input.form.submit();
  });
  if (input) input.addEventListener('change', () => input.form.submit());
}

// The designer's reference photos load only when asked for. They live on
// MakerWorld's CDN at a megabyte or more each, and fetching them on every page
// view would mean this tool pulling someone else's bandwidth for pictures
// nobody opened. Swapped in once, on the first open.
for (const box of document.querySelectorAll('.refbox')) {
  box.addEventListener('toggle', () => {
    if (!box.open) return;
    for (const img of box.querySelectorAll('img[data-src]')) {
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
    }
  });
}

// The publish button follows the marketplace you picked. Blockers are not
// shared between the two — Etsy refusing a third-party design says nothing
// about eBay — so a single combined verdict locked out a marketplace that had
// nothing wrong with it. The server checks the selected one on its own; this
// only keeps the button honest about which.
const market = document.getElementById('publish-market');
if (market) {
  const button = document.getElementById('publish-btn');
  const note = document.getElementById('publish-note');
  const form = market.closest('form');
  const paint = () => {
    const option = market.selectedOptions[0];
    const blockers = Number(option?.dataset.blockers || 0);
    const live = option?.dataset.live === '1';
    const name = (option?.textContent || '').replace(/ — live$/, '').trim();
    button.disabled = blockers > 0;
    // The same button publishes or revises depending on the marketplace's
    // state, and both the label and the money question have to say which.
    button.textContent = live ? 'Änderungen übertragen' : 'Live schalten';
    if (form) form.dataset.confirm = live ? form.dataset.confirmRevise : form.dataset.confirmPublish;
    // Built from nodes rather than innerHTML: the name comes out of the DOM,
    // and the link target is the one fixed anchor this page has.
    note.textContent = '';
    if (blockers > 0) {
      note.appendChild(document.createTextNode('Gesperrt: ' + blockers + ' Blocker für ' + name + ' offen — '));
      const a = document.createElement('a');
      a.href = '#preflight';
      a.textContent = 'zum Preflight';
      note.appendChild(a);
    } else {
      note.textContent = live
        ? name + ' ist live — überträgt die bearbeiteten Texte aufs laufende Inserat.'
        : 'Preflight für ' + name + ' ist sauber.';
    }
  };
  market.addEventListener('change', paint);
  paint();
}

// Anything that costs money asks first, with the amount in the question.
for (const form of document.querySelectorAll('[data-confirm]')) {
  form.addEventListener('submit', (e) => {
    if (!window.confirm(form.dataset.confirm)) e.preventDefault();
  });
}

// Submitting is not instant — the saved page has to upload before the server
// can even answer. Without this the button looks unpressed and gets pressed
// again, which on the create form means a second listing.
for (const form of document.querySelectorAll('[data-busy]')) {
  form.addEventListener('submit', () => {
    for (const button of form.querySelectorAll('button[type=submit]')) {
      button.disabled = true;
      button.textContent = form.dataset.busy;
    }
  });
}

// Live progress for a running creation job. Polls the state the command is
// actually writing rather than animating a guess.
const job = document.getElementById('job');
if (job && job.dataset.state === 'running') {
  const lines = document.getElementById('job-lines');
  const status = document.getElementById('job-status');
  const bar = document.getElementById('job-bar');
  const started = Date.now();
  let stop = false;

  const render = (state) => {
    // Only append what is new: re-rendering the whole list would fight the
    // scroll position on every poll.
    for (let i = lines.children.length; i < state.lines.length; i++) {
      const line = state.lines[i];
      const el = document.createElement('div');
      el.className = 'pl ' + line.level;
      el.textContent = line.message;
      lines.appendChild(el);
    }
    if (lines.children.length) lines.scrollTop = lines.scrollHeight;

    if (state.state === 'running') {
      const seconds = Math.round((Date.now() - started) / 1000);
      status.textContent = 'Läuft seit ' + seconds + ' s — ' + (job.dataset.hint || '');
      return;
    }

    stop = true;
    bar.classList.add(state.state === 'done' ? 'done' : 'failed');

    if (state.state === 'done') {
      status.textContent = 'Fertig. Weiter zum Entwurf…';
      window.location.href = '/listing/' + encodeURIComponent(state.result);
      return;
    }

    status.textContent = 'Abgebrochen — nichts wurde gespeichert.';
    const box = document.getElementById('job-error');
    if (box && state.error) {
      const banner = document.createElement('div');
      banner.className = 'banner bad';
      const strong = document.createElement('strong');
      strong.textContent = state.error.message;
      banner.appendChild(strong);
      if (state.error.hint) {
        banner.appendChild(document.createElement('br'));
        banner.appendChild(document.createTextNode(state.error.hint));
      }
      box.appendChild(banner);
    }
  };

  const poll = async () => {
    if (stop) return;
    try {
      const response = await fetch('/progress/' + encodeURIComponent(job.dataset.job) + '/state');
      // The server answers an unknown job id with 404 *plus* a JSON body whose
      // state is 'failed' — the registry is in-memory, so a restart forgets
      // running jobs. Rendering that body ends the poll with an honest message
      // instead of counting seconds forever against a job nobody is running.
      if (response.ok || response.status === 404) render(await response.json());
    } catch (error) {
      // A dropped poll is not a failed job — the work runs on the server. Keep
      // trying; the page reload path shows the outcome either way.
    }
    if (!stop) setTimeout(poll, 800);
  };
  poll();
}
`
