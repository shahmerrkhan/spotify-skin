// Queue panel. Spotify's MPRIS has no queue, so until the Web API (phase 3) it
// shows "Recently played": the current song as the highlighted row, then the
// last songs this computer played (up to 50; the list scrolls with the mouse
// wheel). Built with textContent only (no HTML from metadata).

const MAX_ROWS = 51; // the current song + the 50 in history

const thumb = (name) => `app://skin/art/${name}-t.jpg`;

function row({ title, artist, art }, hero) {
  const li = document.createElement('li');
  li.className = hero ? 'row row--hero' : 'row';
  const img = document.createElement('img');
  img.className = 'row__art';
  img.alt = '';
  img.decoding = 'async';
  if (art) img.src = thumb(art);
  else img.style.visibility = 'visible'; // shows the gradient placeholder
  const text = document.createElement('div');
  text.className = 'row__text';
  const t = document.createElement('span');
  t.className = 'line cav row__t';
  t.textContent = title;
  const a = document.createElement('span');
  a.className = 'line cav row__a dim';
  a.textContent = artist || '';
  text.append(t, a);
  li.append(img, text);
  if (hero) li.setAttribute('aria-current', 'true');
  return li;
}

export function createQueue({ list, empty }) {
  let lastKey = '';

  // Fade the edge of the list only where there's more to scroll to.
  let raf = 0;
  const edges = () => {
    raf = 0;
    const max = list.scrollHeight - list.clientHeight;
    list.classList.toggle('more-above', list.scrollTop > 2);
    list.classList.toggle('more-below', list.scrollTop < max - 2);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(edges); };
  list.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(list);

  return {
    render({ current, currentArt, history }) {
      const rows = [];
      if (current) rows.push({ ...current, art: currentArt, hero: true });
      for (const h of history) {
        if (rows.length >= MAX_ROWS) break;
        if (current && h.id === current.id) continue;
        rows.push(h);
      }
      const key = JSON.stringify(rows.map((r) => [r.id, r.title, r.artist, r.art, r.hero]));
      if (key === lastKey) return;
      lastKey = key;
      list.replaceChildren(...rows.map((r) => row(r, Boolean(r.hero))));
      empty.hidden = rows.length > 0;
      schedule();
    },
  };
}
