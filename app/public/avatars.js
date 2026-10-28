// avatars.js — character portraits and icons drawn in code (no images).
// Comic look (2026-10-18): shapes carry part classes so app.css can ink them in black and white:
// o = gets an ink outline · sk skin · hr hair · cl clothes in the character colour · cl2 dark clothes
// wh white clothes · gd gold · ln ink line (stroke only) · bl blush · mo mouth · bd white brows/moustache
// hat straw hat · gl glasses rim · hl eye highlight · eyes = blink group (app.css .thinking uses it)
'use strict';

const SKIN = { jaem: '#E2B48A', perm: '#C99367', fah: '#F0CDA8', wit: '#E6BE96', muay: '#F2D3B3', tee: '#D9A77C' };
const INK = '#1C1A1E';

const ln = (d, w = 3.5) => `<path class="ln" d="${d}" fill="none" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
function eyes(y = 104, gap = 18, r = 4.5) {
  return `<g class="eyes"><ellipse class="ey" cx="${100 - gap}" cy="${y}" rx="${r}" ry="${r + 1}" fill="${INK}"/><ellipse class="ey" cx="${100 + gap}" cy="${y}" rx="${r}" ry="${r + 1}" fill="${INK}"/></g>`;
}
const neck = (id) => `<rect class="sk o" x="88" y="132" width="24" height="26" fill="${SKIN[id]}"/>`;
const head = (id) => `<ellipse class="sk o" cx="54" cy="108" rx="7" ry="10" fill="${SKIN[id]}"/><ellipse class="sk o" cx="146" cy="108" rx="7" ry="10" fill="${SKIN[id]}"/>` +
  `<ellipse class="sk o" cx="100" cy="104" rx="46" ry="50" fill="${SKIN[id]}"/>`;
const torso = (cls, fill) => `<path class="${cls} o" d="M28 202 C32 170 60 154 100 154 C140 154 168 170 172 202 Z" fill="${fill}"/>`;

const AVATAR = {
  jaem: (c) => torso('cl', c) + ln('M84 155 L100 174 L116 155', 3) + neck('jaem') + head('jaem') +
    `<circle class="hr o" cx="100" cy="44" r="20" fill="#3A3436"/>` +
    `<path class="hr o" d="M54 100 C52 62 76 50 100 50 C124 50 148 62 146 100 C140 80 124 70 100 70 C76 70 60 80 54 100 Z" fill="#3A3436"/>` +
    `<path class="ln" d="M86 50 Q100 41 114 50" stroke="#7A6E72" stroke-width="3" fill="none"/>` +
    eyes(104, 18, 4.5) + ln('M72 90 Q82 85 92 90 M108 90 Q118 85 128 90', 3) +
    `<ellipse class="bl" cx="74" cy="122" rx="8" ry="5" fill="#D9786F" opacity=".45"/><ellipse class="bl" cx="126" cy="122" rx="8" ry="5" fill="#D9786F" opacity=".45"/>` +
    `<path class="mo" d="M86 128 Q100 141 114 128 Z" fill="#8E3B3B" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` +
    `<circle class="gd o" cx="54" cy="123" r="4.5" fill="#E2B33C"/><circle class="gd o" cx="146" cy="123" r="4.5" fill="#E2B33C"/>`,

  perm: () => torso('cl2', '#2E3A5C') + ln('M100 156 L100 202', 3) +
    `<circle class="gd" cx="100" cy="174" r="3" fill="#C9C2B0"/><circle class="gd" cx="100" cy="190" r="3" fill="#C9C2B0"/>` +
    neck('perm') + head('perm') +
    `<path class="hat o" d="M26 80 L100 26 L174 80 Q100 94 26 80 Z" fill="#D7B56D"/>` +
    `<path class="ln" d="M62 64 Q100 72 138 64 M44 74 Q100 84 156 74" stroke="#9E7E3C" stroke-width="2.5" fill="none"/>` +
    `<path class="bd" d="M70 95 L92 92 M108 92 L130 95" stroke="#E4DED4" stroke-width="6" stroke-linecap="round"/>` +
    eyes(106, 18, 4) +
    `<path class="bd o" d="M76 123 Q88 117 100 123 Q112 117 124 123 Q112 132 100 128 Q88 132 76 123 Z" fill="#E4DED4"/>` +
    ln('M92 138 Q100 141 108 138', 3) + `<path class="ln" d="M70 114 Q74 119 70 124 M130 114 Q126 119 130 124" stroke="#00000040" stroke-width="2" fill="none"/>`,

  fah: (c) => torso('wh', '#F4F1EA') +
    `<path class="cl2 o" d="M64 158 L100 176 L136 158 L130 172 L100 186 L70 172 Z" fill="#26407A"/><path class="cl2 o" d="M95 178 L105 178 L103 200 L97 200 Z" fill="#26407A"/>` +
    neck('fah') +
    `<circle class="hr o" cx="43" cy="100" r="17" fill="#221E22"/><circle class="hr o" cx="157" cy="100" r="17" fill="#221E22"/>` +
    `<rect class="cl o" x="52" y="86" width="10" height="14" rx="3" fill="${c}"/><rect class="cl o" x="138" y="86" width="10" height="14" rx="3" fill="${c}"/>` +
    head('fah') +
    `<path class="hr o" d="M54 102 C50 60 76 52 100 52 C124 52 150 60 146 102 C142 86 136 80 128 78 L122 88 L112 78 L100 90 L88 78 L78 88 L72 78 C64 80 58 88 54 102 Z" fill="#221E22"/>` +
    `<g class="eyes"><ellipse class="ey" cx="82" cy="108" rx="6" ry="7.5" fill="${INK}"/><ellipse class="ey" cx="118" cy="108" rx="6" ry="7.5" fill="${INK}"/><circle class="hl" cx="84" cy="105" r="2" fill="#fff"/><circle class="hl" cx="120" cy="105" r="2" fill="#fff"/></g>` +
    `<ellipse class="bl" cx="72" cy="124" rx="7" ry="4" fill="#E58A8A" opacity=".5"/><ellipse class="bl" cx="128" cy="124" rx="7" ry="4" fill="#E58A8A" opacity=".5"/>` +
    `<path class="mo" d="M90 130 Q100 141 110 130 Z" fill="#8E3B3B" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>`,

  wit: (c) => torso('wh', '#EEEBE4') + `<path class="wh o" d="M86 154 L100 168 L114 154" fill="#DCD8CF"/>` +
    `<path class="cl o" d="M96 164 L104 164 L108 198 L100 204 L92 198 Z" fill="${c}"/>` +
    neck('wit') + head('wit') +
    `<path class="hr o" d="M54 98 C52 60 78 50 104 52 C128 54 148 66 146 98 C144 84 134 74 118 72 C104 78 80 76 64 82 C58 86 55 92 54 98 Z" fill="#26232A"/>` +
    eyes(106, 18, 4) +
    `<rect class="gl" x="66" y="94" width="30" height="22" rx="4" fill="#ffffff22" stroke="${INK}" stroke-width="3.5"/>` +
    `<rect class="gl" x="104" y="94" width="30" height="22" rx="4" fill="#ffffff22" stroke="${INK}" stroke-width="3.5"/>` +
    ln('M96 104 L104 104 M70 88 L92 86 M108 86 L130 88 M90 134 L110 134'),

  muay: (c) => torso('cl', c) + `<path class="ln" d="M74 160 Q100 184 126 160" stroke="#E2B33C" stroke-width="4" fill="none"/><circle class="gd o" cx="100" cy="176" r="5" fill="#E2B33C"/>` +
    neck('muay') +
    `<path class="hr o" d="M48 104 C44 58 74 46 100 46 C126 46 156 58 152 104 L154 140 C150 146 140 146 136 140 L136 100 L64 100 L64 140 C60 146 50 146 46 140 Z" fill="#1A171B"/>` +
    head('muay') +
    `<path class="hr o" d="M56 96 C56 64 76 54 100 54 C124 54 144 64 144 96 L56 96 Z" fill="#1A171B"/>` +
    eyes(110, 18, 4.5) + ln('M70 98 L92 100 M108 94 Q120 88 130 94') +
    `<path class="mo lip" d="M88 132 Q100 127 112 132 Q100 141 88 132 Z" fill="#B3263A" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/>` +
    `<circle class="gd o" cx="54" cy="124" r="4" fill="#E2B33C"/><circle class="gd o" cx="146" cy="124" r="4" fill="#E2B33C"/>`,

  tee: (c) => torso('cl', c) + ln('M74 154 Q100 172 126 154', 4) + `<path class="ln" d="M90 168 L90 198 M110 168 L110 198" stroke="#F4F1EA" stroke-width="3.5" stroke-linecap="round"/>` +
    neck('tee') +
    `<path class="ln" d="M50 150 Q100 182 150 150" stroke="#222026" stroke-width="8" fill="none"/>` +
    `<rect class="cl2 o" x="38" y="136" width="22" height="28" rx="8" fill="#222026"/><rect class="cl2 o" x="140" y="136" width="22" height="28" rx="8" fill="#222026"/>` +
    head('tee') +
    `<path class="hr o" d="M54 92 L60 70 L70 84 L78 64 L88 80 L98 60 L108 78 L118 62 L126 80 L136 68 L140 86 L146 92 C140 80 124 74 100 74 C76 74 60 80 54 92 Z" fill="#2A2420"/>` +
    `<path class="cl o" d="M58 84 C58 54 80 44 100 44 C120 44 142 54 142 84 Z" fill="${c}"/>` +
    `<path class="cl o" d="M38 82 L60 76 L62 86 L40 92 Z" fill="${c}"/>` +
    eyes(108, 18, 4) + ln('M72 96 L92 98 M108 98 L128 96 M88 132 Q102 138 114 128'),
};

function avatarSVG(id, color) {
  const fn = AVATAR[id];
  const inner = fn ? fn(color) : head('wit') + eyes();
  return `<svg viewBox="0 0 200 200" class="avatar av-${id}" aria-hidden="true">${inner}</svg>`;
}
// head-and-shoulders crop for vote chips
function faceSVG(id, color) {
  const fn = AVATAR[id];
  const inner = fn ? fn(color) : head('wit') + eyes();
  return `<svg viewBox="30 22 140 140" class="avatar face av-${id}" aria-hidden="true">${inner}</svg>`;
}

const ICON = {
  wolf: '<svg viewBox="0 0 24 24"><path d="M4 3 L9 8 L15 8 L20 3 L19 12 Q19 18 12 21 Q5 18 5 12 Z" fill="currentColor"/><circle cx="9.3" cy="12" r="1.3" fill="var(--icon-cut,#111)"/><circle cx="14.7" cy="12" r="1.3" fill="var(--icon-cut,#111)"/><path d="M10.5 16 L12 17.5 L13.5 16" stroke="var(--icon-cut,#111)" stroke-width="1.4" fill="none"/></svg>',
  seer: '<svg viewBox="0 0 24 24"><path d="M2 12 Q12 3 22 12 Q12 21 2 12 Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.6" fill="currentColor"/></svg>',
  doctor: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="18" rx="1.5" fill="currentColor"/><rect x="3" y="9" width="18" height="6" rx="1.5" fill="currentColor"/></svg>',
  villager: '<svg viewBox="0 0 24 24"><path d="M3 11 L12 3 L21 11 L19 11 L19 21 L5 21 L5 11 Z" fill="currentColor"/><rect x="10" y="14" width="4" height="7" fill="var(--icon-cut,#111)"/></svg>',
  // a bare "?" — the round badge around it comes from app.css
  unknown: '<svg viewBox="0 0 24 24"><path d="M8.2 8.6 Q8.2 4.6 12 4.6 Q15.8 4.6 15.8 8.2 Q15.8 10.6 13.4 11.8 Q12 12.5 12 14.6" stroke="currentColor" stroke-width="2.8" fill="none" stroke-linecap="round"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>',
  claw: '<svg viewBox="0 0 24 24"><path d="M6 3 Q9 12 5 21 M12 2 Q15 12 11 22 M18 3 Q21 12 17 21" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 2 L20 5 L20 11 Q20 18 12 22 Q4 18 4 11 L4 5 Z" fill="currentColor"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/></g></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 15.5 A8.5 8.5 0 1 1 8.5 4 A7 7 0 0 0 20 15.5 Z" fill="currentColor"/></svg>',
  // brush-stroke X for a dead panel (colour from app.css)
  cross: '<svg viewBox="0 0 100 100"><path d="M10 14 Q50 52 90 88 L84 94 Q46 58 6 20 Z M88 10 Q52 50 14 92 L8 86 Q46 46 82 4 Z" fill="currentColor"/></svg>',
};

window.avatarSVG = avatarSVG;
window.faceSVG = faceSVG;
window.ICON = ICON;

// look switch: "ink" (black-and-white comic) or "color" (app-color.css). index.html applies it before first paint;
// here: lobby buttons, the C key, and ?look=… — the choice is remembered in this browser profile.
(function lookSwitch() {
  const root = document.documentElement;
  const save = (look) => { try { localStorage.setItem('vreki-look', look); } catch (e) {} };
  const set = (look) => {
    root.classList.toggle('look-color', look === 'color');
    save(look);
    document.querySelectorAll('[data-look]').forEach((b) => b.classList.toggle('on', b.dataset.look === look));
  };
  const urlLook = new URLSearchParams(location.search).get('look');
  set(urlLook === 'color' || urlLook === 'ink' ? urlLook : (root.classList.contains('look-color') ? 'color' : 'ink'));
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-look]'); if (b) set(b.dataset.look); });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (e.key === 'c' || e.key === 'C') set(root.classList.contains('look-color') ? 'ink' : 'color');
  });
})();

// speed lines behind the centred announcement (drawn once; app.css picks the colour)
(function speedLines() {
  const box = document.querySelector('#announce .a-box');
  if (!box) return;
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let d = '';
  for (let i = 0; i < 90; i++) {
    const y = rnd() * 500, len = 90 + rnd() * 300, th = 0.8 + rnd() * 3.2;
    d += i % 2 === 0
      ? `M-5 ${y.toFixed(1)} L${len.toFixed(1)} ${(y + th / 2).toFixed(1)} L-5 ${(y + th).toFixed(1)} Z `
      : `M1005 ${y.toFixed(1)} L${(1000 - len).toFixed(1)} ${(y + th / 2).toFixed(1)} L1005 ${(y + th).toFixed(1)} Z `;
  }
  box.insertAdjacentHTML('afterbegin', `<svg class="speed" viewBox="0 0 1000 500" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>`);
})();
