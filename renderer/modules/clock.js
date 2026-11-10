// Big handwritten clock with a date line. Digits sit in fixed-width slots so
// nothing shifts when the minute changes. Updates once a minute, on the minute.

const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long' });

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

export function startClock({ root, dateEl, timeEl, h24 = true }) {
  let timer = 0;

  function render() {
    const now = new Date();
    let h = now.getHours();
    let suffix = '';
    if (!h24) {
      suffix = h < 12 ? 'am' : 'pm';
      h = h % 12 || 12;
    }
    const hh = h24 ? String(h).padStart(2, '0') : String(h);
    const mm = String(now.getMinutes()).padStart(2, '0');
    const date = `${WEEKDAY.format(now)}, ${now.getDate()} ${MONTH.format(now)}`;

    const parts = [...hh].map((d) => span('clock__d', d));
    parts.push(span('clock__c', ':'), ...[...mm].map((d) => span('clock__d', d)));
    if (suffix) parts.push(span('clock__ampm', suffix));
    timeEl.replaceChildren(...parts);
    dateEl.textContent = date;
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', `${hh}:${mm}${suffix ? ` ${suffix}` : ''}, ${date}`);
  }

  function schedule() {
    clearTimeout(timer);
    const now = new Date();
    const ms = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
    timer = setTimeout(() => {
      render();
      schedule();
    }, ms);
  }

  render();
  schedule();
  // After sleep the timer may fire late; the caller refreshes on resume.
  return { refresh: () => { render(); schedule(); } };
}
